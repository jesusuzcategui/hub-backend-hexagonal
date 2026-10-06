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
import { runVerificationPass } from "../review-verification.service";
import { EpaycoContrasteUnavailableError } from "../../../adapters/payments/epayco-provider";
import { adminRoutes } from "../../admin/admin.routes";

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
    await fastify.register(adminRoutes);
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

  beforeEach(async () => {
    // Isolation: a pass scans the whole table, so orders left over from earlier tests must not be due again.
    if (orderIds.length) await db.update(orders).set({ reviewNextVerifyAt: null }).where(inArray(orders.id, orderIds));
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

  // ---- automatic re-verification pass ------------------------------------------------------------------------

  type FakeProvider = { validateTransactionByReference: ReturnType<typeof vi.fn> };
  const fakeProvider = (answer: (ref: string) => Promise<{ amountMinor: number; currency: string; invoice: string }>): FakeProvider => ({
    validateTransactionByReference: vi.fn(answer),
  });
  const confirms = (orderId: string) =>
    fakeProvider(async () => ({ invoice: orderId, amountMinor: AMOUNT, currency: "COP" }));
  const unavailable = () =>
    fakeProvider(async () => {
      throw new EpaycoContrasteUnavailableError("test");
    });

  /** An order flagged by a webhook whose contraste was unavailable. */
  async function newFlaggedOrder(ref = `ref-${seq++}`) {
    const { orderId, userId } = await newOpenOrder();
    await deliverWebhook(orderId, ref);
    const row = await orderRow(orderId);
    expect(row.reviewReason).toBe("contraste_unavailable");
    sendMail.mockClear();
    return { orderId, userId, ref, flaggedAt: row.reviewFlaggedAt! };
  }
  const after = (flaggedAt: Date, minutes: number) => new Date(flaggedAt.getTime() + minutes * MIN);
  const pass = (now: Date, provider: FakeProvider, extra: Record<string, unknown> = {}) =>
    runVerificationPass(fastify, { now, provider: provider as never, ...extra });

  describe("runVerificationPass", () => {
    it("does nothing before the first retry is due", async () => {
      const { flaggedAt, orderId } = await newFlaggedOrder();
      const p = confirms(orderId);
      const summary = await pass(after(flaggedAt, 1.9), p);
      expect(summary.claimed).toBe(0);
      expect(p.validateTransactionByReference).not.toHaveBeenCalled();
      expect((await orderRow(orderId)).reviewVerifyAttempts).toBe(0);
    });

    it("at +2 min with ePayco confirming clears the order automatically and leaves an audit trail", async () => {
      const { flaggedAt, orderId, ref, userId } = await newFlaggedOrder();
      const p = confirms(orderId);

      const summary = await pass(after(flaggedAt, 2), p);

      expect(summary).toMatchObject({ claimed: 1, cleared: 1, mismatched: 0, unavailable: 0 });
      expect(p.validateTransactionByReference).toHaveBeenCalledTimes(1);
      expect(p.validateTransactionByReference).toHaveBeenCalledWith(ref); // ePayco's own reference, never the webhook body
      const o = await orderRow(orderId);
      expect(o.fulfillmentStatus).toBe("delivered");
      expect(o.reviewVerifyAttempts).toBe(1);
      expect(o.reviewReason).toBeNull();
      expect(o.reviewNextVerifyAt).toBeNull();
      expect(await eventKinds(orderId)).toEqual(["flagged", "auto_cleared"]);
      expect(mailsToAdmin()).toHaveLength(0);
      expect((await getPublicOrderStatus(fastify, orderId)).fulfillmentStatus).toBe("delivered");
      expect((await listOrdersForStudent(fastify, userId)).find((r) => r.id === orderId)!.fulfillmentStatus).toBe("delivered");

      // and a second pass has nothing left to do
      expect((await pass(after(flaggedAt, 3), p)).claimed).toBe(0);
      expect(p.validateTransactionByReference).toHaveBeenCalledTimes(1);
    });

    it("falls back to the ePayco reference stored in payment_events when the order has none of its own", async () => {
      const { flaggedAt, orderId, ref } = await newFlaggedOrder();
      await db.update(orders).set({ reviewProviderRef: null }).where(eq(orders.id, orderId));
      const p = confirms(orderId);
      await pass(after(flaggedAt, 2), p);
      expect(p.validateTransactionByReference).toHaveBeenCalledWith(ref);
      expect((await orderRow(orderId)).fulfillmentStatus).toBe("delivered");
    });

    it("walks the whole backoff while ePayco stays down, then alerts admins exactly once at the end of the window", async () => {
      const { flaggedAt, orderId } = await newFlaggedOrder();
      const p = unavailable();

      for (const [i, minute] of [2, 5, 10, 20, 40].entries()) {
        // not due one minute earlier
        const early = await pass(after(flaggedAt, minute - 1), p);
        expect(early.claimed).toBe(0);
        const s = await pass(after(flaggedAt, minute), p);
        expect(s).toMatchObject({ claimed: 1, unavailable: 1, expired: 0 });
        const o = await orderRow(orderId);
        expect(o.reviewVerifyAttempts).toBe(i + 1);
        expect(o.fulfillmentStatus).toBe("needs_review");
        expect(o.reviewReason).toBe("contraste_unavailable");
      }
      expect(mailsToAdmin()).toHaveLength(0); // no alert while retrying
      expect((await orderRow(orderId)).reviewNextVerifyAt!.getTime()).toBe(after(flaggedAt, 60).getTime());

      const last = await pass(after(flaggedAt, 60), p);
      expect(last).toMatchObject({ claimed: 1, expired: 1 });
      expect(mailsToAdmin()).toHaveLength(1);
      const o = await orderRow(orderId);
      expect(o.fulfillmentStatus).toBe("needs_review"); // kept for a human
      expect(o.reviewNextVerifyAt).toBeNull();
      expect(o.reviewAlertedAt).not.toBeNull();
      expect(o.reviewVerifyAttempts).toBe(6);
      expect(await eventKinds(orderId)).toEqual([
        "flagged", "verify_unavailable", "verify_unavailable", "verify_unavailable", "verify_unavailable", "verify_unavailable", "verify_unavailable", "window_expired",
      ]);

      // a second pass (even much later) sends nothing and never calls ePayco again
      const calls = p.validateTransactionByReference.mock.calls.length;
      expect((await pass(after(flaggedAt, 600), p)).claimed).toBe(0);
      expect(mailsToAdmin()).toHaveLength(1);
      expect(p.validateTransactionByReference.mock.calls.length).toBe(calls);
      // the student still sees a confirmed order
      expect((await getPublicOrderStatus(fastify, orderId)).fulfillmentStatus).toBe("delivered");
    });

    it("a restart after a very long outage does one attempt, alerts once and never hammers ePayco", async () => {
      const { flaggedAt, orderId } = await newFlaggedOrder();
      const p = unavailable();
      const late = after(flaggedAt, 300);
      expect((await pass(late, p)).expired).toBe(1);
      expect((await pass(late, p)).claimed).toBe(0);
      expect((await pass(after(flaggedAt, 301), p)).claimed).toBe(0);
      expect(p.validateTransactionByReference).toHaveBeenCalledTimes(1);
      expect(mailsToAdmin()).toHaveLength(1);
      expect((await orderRow(orderId)).fulfillmentStatus).toBe("needs_review");
    });

    it.each([
      ["different amount", (id: string) => ({ invoice: id, amountMinor: AMOUNT - 1, currency: "COP" })],
      ["different currency", (id: string) => ({ invoice: id, amountMinor: AMOUNT, currency: "USD" })],
      ["different invoice", (_id: string) => ({ invoice: "someone-elses-order", amountMinor: AMOUNT, currency: "COP" })],
    ])("a genuine mismatch (%s) is never auto-cleared and alerts admins immediately, once", async (_name, data) => {
      const { flaggedAt, orderId } = await newFlaggedOrder();
      const p = fakeProvider(async () => data(orderId));

      const s = await pass(after(flaggedAt, 2), p);

      expect(s).toMatchObject({ claimed: 1, mismatched: 1, cleared: 0 });
      const o = await orderRow(orderId);
      expect(o.fulfillmentStatus).toBe("needs_review");
      expect(o.reviewReason).toBe("contraste_mismatch");
      expect(o.reviewNextVerifyAt).toBeNull();
      expect(mailsToAdmin()).toHaveLength(1);
      expect(String(mailsToAdmin()[0].html)).toContain(orderId);
      expect(await eventKinds(orderId)).toEqual(["flagged", "mismatch"]);

      // no second alert, no second call, no later clearing even if ePayco later "agrees"
      const ok = confirms(orderId);
      expect((await pass(after(flaggedAt, 600), ok)).claimed).toBe(0);
      expect(ok.validateTransactionByReference).not.toHaveBeenCalled();
      expect(mailsToAdmin()).toHaveLength(1);
      expect((await orderRow(orderId)).fulfillmentStatus).toBe("needs_review");
      // the student is NOT told it is fine any more: a mismatch is a real problem
      expect((await getPublicOrderStatus(fastify, orderId)).fulfillmentStatus).toBe("needs_review");
    });

    it("an unexpected provider error counts as unavailable and does not stop the other orders of the pass", async () => {
      const a = await newFlaggedOrder();
      const b = await newFlaggedOrder();
      const p = fakeProvider(async (ref) => {
        if (ref === a.ref) throw new Error("boom: socket hang up");
        return { invoice: b.orderId, amountMinor: AMOUNT, currency: "COP" };
      });
      const now = after(new Date(Math.max(a.flaggedAt.getTime(), b.flaggedAt.getTime())), 2);

      const s = await pass(now, p);

      expect(s.claimed).toBeGreaterThanOrEqual(2);
      expect((await orderRow(a.orderId)).fulfillmentStatus).toBe("needs_review");
      expect((await orderRow(a.orderId)).reviewVerifyAttempts).toBe(1);
      expect((await orderRow(b.orderId)).fulfillmentStatus).toBe("delivered");
    });

    it("never lets two overlapping passes process the same order (atomic claim)", async () => {
      const { flaggedAt, orderId } = await newFlaggedOrder();
      const slow = fakeProvider(async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { invoice: orderId, amountMinor: AMOUNT, currency: "COP" };
      });
      const now = after(flaggedAt, 2);

      // Barrier: every pass has SELECTed the order as due before any of them tries to claim it, so the claim
      // condition is the only thing standing between them and a double verification.
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const onDue = async () => {
        if (++arrived === 3) release();
        await gate;
      };
      const results = await Promise.all([1, 2, 3].map(() => pass(now, slow, { onDue })));

      expect(slow.validateTransactionByReference).toHaveBeenCalledTimes(1);
      expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(1);
      expect((await orderRow(orderId)).reviewVerifyAttempts).toBe(1);
      expect(await eventKinds(orderId)).toEqual(["flagged", "auto_cleared"]);
    });

    it("does not touch a needs_review caused by a failed grant (no ePayco call, alert already sent at flag time)", async () => {
      const [dead] = await db
        .insert(products)
        .values({ externalId: `${TAG}_dead${seq}`, contentType: "nodus_product", slug: `${TAG}-dead${seq}`, name: "Inactive", metadata: {}, isActive: false })
        .returning({ id: products.id });
      productIds.push(dead.id);
      const { orderId } = await newOpenOrder({ productId: dead.id });
      await deliverWebhook(orderId, `ref-${seq++}`);
      expect(mailsToAdmin()).toHaveLength(1);
      const row = await orderRow(orderId);
      const p = confirms(orderId);

      const s = await pass(after(row.reviewFlaggedAt!, 600), p);

      expect(p.validateTransactionByReference).not.toHaveBeenCalled();
      expect(s.claimed).toBe(0);
      const o = await orderRow(orderId);
      expect(o.fulfillmentStatus).toBe("needs_review");
      expect(o.reviewReason).toBe("fulfillment_failed");
      expect(mailsToAdmin()).toHaveLength(1);
    });

    it("dryRun reports what would be verified without calling ePayco or changing anything", async () => {
      const { flaggedAt, orderId } = await newFlaggedOrder();
      const p = confirms(orderId);
      const s = await pass(after(flaggedAt, 2), p, { dryRun: true });
      expect(s.dryRun).toBe(true);
      expect(s.checked).toBeGreaterThanOrEqual(1);
      expect(s.claimed).toBe(0);
      expect(p.validateTransactionByReference).not.toHaveBeenCalled();
      const o = await orderRow(orderId);
      expect(o.reviewVerifyAttempts).toBe(0);
      expect(o.fulfillmentStatus).toBe("needs_review");
    });
  });
});
