// DB-backed tests for the ePayco "contraste unavailable" flow: flagging at webhook time, the automatic
// re-verification pass, the admin endpoints and the student-facing mapping. They NEVER touch DATABASE_URL: they
// only run when PAYVERIFY_IT_DATABASE_URL points at a throwaway database whose name ends with _it. ePayco is
// never called (global fetch is stubbed / a fake provider is injected) and the mailer is always a mock.
//   PAYVERIFY_IT_DATABASE_URL=postgres://postgres:x@localhost:5433/hub_pay_it pnpm exec vitest run payment-verification.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDrizzle } from "../../../db";
import { accounts } from "../../../db/schema/users";
import { products } from "../../../db/schema/ecommerce";
import { orders, orderReviewEvents, paymentAttempts, paymentEvents } from "../../../db/schema/payments";
import { classCredits } from "../../../db/schema/scheduling";
import { contentAccess } from "../../../db/schema/ecommerce";
import { AppError } from "../../../lib/errors";
import { handleEpaycoWebhook, getPublicOrderStatus, listOrdersForStudent } from "../payments.service";
import { env } from "../../../config/env";

const DB_URL = process.env.PAYVERIFY_IT_DATABASE_URL;
const dbName = DB_URL ? new URL(DB_URL).pathname.slice(1) : "";
if (DB_URL && !/_it$/.test(dbName)) {
  throw new Error(`Refusing to run payment verification integration tests against database "${dbName}"`);
}

const MIN = 60_000;
const TAG = `pvit_${Date.now()}`;
const AMOUNT = 150_000; // COP, zero-decimal: x_amount "150000"

describe.skipIf(!DB_URL)("payment auto-verification (throwaway DB)", () => {
  let pool: Pool;
  let db: ReturnType<typeof createDrizzle>;
  let fastify: FastifyInstance;
  let sendMail: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let productId: string;
  let adminEmail: string;
  const accountIds: string[] = [];
  const orderIds: string[] = [];
  const productIds: string[] = [];
  let seq = 0;

  /** What the stubbed ePayco "contraste" endpoint answers. */
  type Contraste = "unavailable" | { invoice: string; amount: string; currency: string };
  let contraste: Contraste = "unavailable";

  function stubEpayco() {
    fetchMock = vi.fn(async (url: string | URL) => {
      if (!String(url).includes("secure.epayco.co/validation/v1/reference/")) {
        throw new Error(`unexpected outbound fetch in test: ${String(url)}`);
      }
      if (contraste === "unavailable") {
        return new Response(JSON.stringify({ status: false, message: "Error de datos o conexión." }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: true,
          data: { x_id_invoice: contraste.invoice, x_amount: contraste.amount, x_currency_code: contraste.currency },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  async function newAccount(role: "user" | "admin" = "user", locale: "es" | "en" = "es") {
    const n = seq++;
    const [a] = await db
      .insert(accounts)
      .values({ email: `${TAG}_${role}${n}@hub.test`, displayName: `IT ${role} ${n}`, role, locale })
      .returning({ id: accounts.id, email: accounts.email });
    accountIds.push(a.id);
    return a;
  }

  /** An open order with one pending ePayco attempt, ready to receive the confirmation webhook. */
  async function newOpenOrder(opts: { productId?: string; userId?: string } = {}) {
    const userId = opts.userId ?? (await newAccount()).id;
    const [o] = await db
      .insert(orders)
      .values({
        kind: "class_credit_plan",
        kindVersion: 1,
        origin: "web",
        currency: "COP",
        amountMinor: AMOUNT,
        status: "open",
        fulfillmentStatus: "pending",
        userId,
        metadata: { cartId: "00000000-0000-4000-8000-0000000000aa", productId: opts.productId ?? productId, creditsCount: 4, locale: "es", couponId: null, items: [] },
      })
      .returning({ id: orders.id });
    orderIds.push(o.id);
    await db.insert(paymentAttempts).values({ orderId: o.id, provider: "epayco", status: "pending" });
    return { orderId: o.id, userId };
  }

  function webhookBody(orderId: string, ref: string, over: Partial<Record<string, string>> = {}) {
    const fields: Record<string, string> = {
      x_ref_payco: ref,
      x_transaction_id: `tx-${ref}`,
      x_amount: String(AMOUNT),
      x_currency_code: "COP",
      x_id_invoice: orderId,
      x_transaction_state: "Aceptada",
      ...over,
    };
    const raw = [env.epayco.custIdCliente, env.epayco.pKey, fields.x_ref_payco, fields.x_transaction_id, fields.x_amount, fields.x_currency_code].join("^");
    fields.x_signature = createHash("sha256").update(raw).digest("hex");
    return new URLSearchParams(fields).toString();
  }

  async function deliverWebhook(orderId: string, ref = `ref-${seq++}`, over: Partial<Record<string, string>> = {}) {
    return handleEpaycoWebhook(fastify, webhookBody(orderId, ref, over), {});
  }

  const orderRow = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
  const eventKinds = async (id: string) =>
    (await db.select().from(orderReviewEvents).where(eq(orderReviewEvents.orderId, id)).orderBy(orderReviewEvents.createdAt)).map((e) => e.kind);
  const mailsToAdmin = () => sendMail.mock.calls.map((c) => c[0]).filter((m) => String(m.to).includes(adminEmail));
  const mailsToBuyer = (email: string) => sendMail.mock.calls.map((c) => c[0]).filter((m) => m.to === email);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    db = createDrizzle(pool);
    sendMail = vi.fn().mockResolvedValue({});
    fastify = Fastify();
    fastify.decorate("drizzle", db);
    fastify.decorate("mailer", { sendMail } as any);
    fastify.decorate("authenticate", async (req: any) => {
      req.user = { sub: req.headers["x-user"], role: req.headers["x-role"] ?? "user" };
    });
    fastify.setErrorHandler((error: any, _req, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.status(500).send({ error: error.message });
    });
    await fastify.ready();

    const admin = await newAccount("admin");
    adminEmail = admin.email;
    const [p] = await db
      .insert(products)
      .values({ externalId: `${TAG}_p`, contentType: "nodus_product", slug: `${TAG}-p`, name: "IT Plan", metadata: {} })
      .returning({ id: products.id });
    productId = p.id;
    productIds.push(p.id);
  });

  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({});
    contraste = "unavailable";
    stubEpayco();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (!pool) return;
    if (orderIds.length) {
      await db.delete(paymentEvents).where(inArray(paymentEvents.orderId, orderIds));
      await db.delete(contentAccess).where(inArray(contentAccess.orderId, orderIds));
      await db.delete(classCredits).where(inArray(classCredits.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds)); // cascades attempts + review events
    }
    await db.delete(products).where(inArray(products.id, productIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
    await fastify.close();
    await pool.end();
  });

  describe("webhook with ePayco's contraste unavailable", () => {
    it("settles, grants credits, records the reason and does NOT alert admins; the student sees delivered", async () => {
      const { orderId, userId } = await newOpenOrder();
      const before = Date.now();

      const result = await deliverWebhook(orderId, "ref-a");
      expect(result.outcome).toBe("applied");

      const o = await orderRow(orderId);
      expect(o.status).toBe("paid");
      expect(o.fulfillmentStatus).toBe("needs_review");
      expect(o.reviewReason).toBe("contraste_unavailable");
      expect(o.reviewProviderRef).toBe("ref-a");
      expect(o.reviewVerifyAttempts).toBe(0);
      expect(o.reviewAlertedAt).toBeNull();
      expect(o.reviewFlaggedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      // first retry is due 2 minutes after the flag
      expect(o.reviewNextVerifyAt!.getTime() - o.reviewFlaggedAt!.getTime()).toBe(2 * MIN);

      const credits = await db.select().from(classCredits).where(eq(classCredits.orderId, orderId));
      expect(credits).toHaveLength(1);
      expect(mailsToAdmin()).toHaveLength(0);
      const buyer = (await db.select().from(accounts).where(eq(accounts.id, userId)))[0];
      expect(mailsToBuyer(buyer.email)).toHaveLength(1); // the success email still goes out
      expect(await eventKinds(orderId)).toEqual(["flagged"]);

      const dto = await getPublicOrderStatus(fastify, orderId);
      expect(dto.fulfillmentStatus).toBe("delivered");
      const mine = (await listOrdersForStudent(fastify, userId)).find((r) => r.id === orderId)!;
      expect(mine.fulfillmentStatus).toBe("delivered");
    });

    it("a real grant failure is flagged fulfillment_failed, alerts admins immediately and the student keeps needs_review", async () => {
      const [dead] = await db
        .insert(products)
        .values({ externalId: `${TAG}_dead`, contentType: "nodus_product", slug: `${TAG}-dead`, name: "Inactive", metadata: {}, isActive: false })
        .returning({ id: products.id });
      productIds.push(dead.id);
      const { orderId, userId } = await newOpenOrder({ productId: dead.id });

      await deliverWebhook(orderId, "ref-b"); // contraste unavailable AND the credit grant fails

      const o = await orderRow(orderId);
      expect(o.fulfillmentStatus).toBe("needs_review");
      expect(o.reviewReason).toBe("fulfillment_failed");
      expect(o.reviewNextVerifyAt).toBeNull(); // the cron must never touch it
      expect(mailsToAdmin()).toHaveLength(1);
      expect(o.reviewAlertedAt).not.toBeNull();

      expect((await getPublicOrderStatus(fastify, orderId)).fulfillmentStatus).toBe("needs_review");
      expect((await listOrdersForStudent(fastify, userId)).find((r) => r.id === orderId)!.fulfillmentStatus).toBe("needs_review");
    });

    it("a webhook whose contraste confirms the order is delivered with no review state at all", async () => {
      const { orderId } = await newOpenOrder();
      contraste = { invoice: orderId, amount: String(AMOUNT), currency: "COP" };

      await deliverWebhook(orderId, "ref-c");

      const o = await orderRow(orderId);
      expect(o.fulfillmentStatus).toBe("delivered");
      expect(o.reviewReason).toBeNull();
      expect(o.reviewNextVerifyAt).toBeNull();
      expect(mailsToAdmin()).toHaveLength(0);
    });

    it("a genuine contraste mismatch still rejects with 409 and settles nothing (behavior unchanged)", async () => {
      const { orderId } = await newOpenOrder();
      contraste = { invoice: orderId, amount: "1", currency: "COP" };

      await expect(deliverWebhook(orderId, "ref-d")).rejects.toMatchObject({ statusCode: 409, code: "CONTRASTE_MISMATCH" });
      const o = await orderRow(orderId);
      expect(o.status).toBe("open");
      expect(o.reviewReason).toBeNull();
    });

    it("an invalid signature still rejects with 401 before anything else", async () => {
      const { orderId } = await newOpenOrder();
      const body = webhookBody(orderId, "ref-e").replace(/x_signature=[0-9a-f]+/, "x_signature=deadbeef");
      await expect(handleEpaycoWebhook(fastify, body, {})).rejects.toMatchObject({ statusCode: 401 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
