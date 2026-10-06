// DB-backed tests for the class reminder runner and admin endpoints. They NEVER touch DATABASE_URL:
// they only run when REMINDERS_IT_DATABASE_URL points at a throwaway database whose name ends with
// _it, _test or _rem. The mailer is always a mock; no real email is ever sent.
//   REMINDERS_IT_DATABASE_URL=postgres://postgres:x@localhost:5433/hub_rem pnpm exec vitest run reminders.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { eq, inArray } from "drizzle-orm";
import { createDrizzle } from "../../../db";
import { accounts } from "../../../db/schema/users";
import { products } from "../../../db/schema/ecommerce";
import { bookings, classCredits } from "../../../db/schema/scheduling";
import { AppError } from "../../../lib/errors";
import { runReminderPass } from "../reminders.service";
import { adminRoutes } from "../../admin/admin.routes";

const DB_URL = process.env.REMINDERS_IT_DATABASE_URL;
const dbName = DB_URL ? new URL(DB_URL).pathname.slice(1) : "";
if (DB_URL && !/(_it|_test|_rem)$/.test(dbName)) {
  throw new Error(`Refusing to run reminders integration tests against database "${dbName}"`);
}

const H = 3_600_000;
const TAG = `rmit_${Date.now()}`;

describe.skipIf(!DB_URL)("class reminders (throwaway DB)", () => {
  let pool: Pool;
  let db: ReturnType<typeof createDrizzle>;
  let fastify: FastifyInstance;
  let sendMail: ReturnType<typeof vi.fn>;
  let productId: string;
  const accountIds: string[] = [];
  let seq = 0;

  async function newStudent(locale: "es" | "en" = "es", name = "IT Student") {
    const n = seq++;
    const [a] = await db
      .insert(accounts)
      .values({ email: `${TAG}_s${n}@hub.test`, displayName: name, role: "user", locale })
      .returning({ id: accounts.id, email: accounts.email });
    accountIds.push(a.id);
    return a;
  }

  async function newBooking(
    studentId: string,
    over: Partial<typeof bookings.$inferInsert> & { hoursAhead?: number; createdHoursAgo?: number } = {},
  ) {
    const { hoursAhead = 23.5, createdHoursAgo = 72, ...rest } = over;
    const [credit] = await db
      .insert(classCredits)
      .values({ userId: studentId, productId, totalCredits: 4, usedCredits: 1 })
      .returning({ id: classCredits.id });
    const startsAt = new Date(Date.now() + hoursAhead * H);
    const [b] = await db
      .insert(bookings)
      .values({
        studentId,
        creditId: credit.id,
        productId,
        status: "confirmed",
        startsAt,
        endsAt: new Date(startsAt.getTime() + H),
        meetLink: `https://talk.test/clase-${seq++}`,
        createdAt: new Date(Date.now() - createdHoursAgo * H),
        ...rest,
      })
      .returning({ id: bookings.id });
    return b.id;
  }

  const row = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
  const mailsTo = (email: string) => sendMail.mock.calls.map((c) => c[0]).filter((m) => m.to === email);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    db = createDrizzle(pool);
    sendMail = vi.fn().mockResolvedValue({});
    fastify = Fastify();
    fastify.decorate("drizzle", db);
    fastify.decorate("mailer", { sendMail } as any);
    fastify.decorate("caldav", { createEvent: vi.fn(), deleteEvent: vi.fn() });
    fastify.decorate("authenticate", async (req: any) => {
      req.user = { sub: req.headers["x-user"], role: req.headers["x-role"] ?? "user" };
    });
    fastify.setErrorHandler((error: any, _req, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.status(500).send({ error: error.message });
    });
    await fastify.register(adminRoutes);
    await fastify.ready();

    const [p] = await db
      .insert(products)
      .values({ externalId: `${TAG}_p`, contentType: "nodus_product", slug: `${TAG}-p`, name: "IT Plan", metadata: {} })
      .returning({ id: products.id });
    productId = p.id;
  });

  beforeEach(async () => {
    // Isolate tests: bookings left over from a previous test would be picked up by the next pass.
    if (accountIds.length) {
      await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
      await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    }
    sendMail.mockReset();
    sendMail.mockResolvedValue({});
  });

  afterAll(async () => {
    if (!pool) return;
    await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
    await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    await db.delete(products).where(eq(products.id, productId));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
    await fastify.close();
    await pool.end();
  });

  it("sends the 24h reminder exactly once when the runner is invoked twice", async () => {
    const s = await newStudent();
    const id = await newBooking(s.id, { hoursAhead: 23.5 });

    const first = await runReminderPass(fastify, { now: new Date() });
    const second = await runReminderPass(fastify, { now: new Date() });

    expect(first).toMatchObject({ sent24h: 1, sent1h: 0, failed: 0 });
    expect(second).toMatchObject({ sent24h: 0, sent1h: 0, failed: 0 });
    expect(mailsTo(s.email)).toHaveLength(1);
    const b = await row(id);
    expect(b.reminder24hSentAt).not.toBeNull();
    expect(b.reminder1hSentAt).toBeNull();
    expect(b.reminderSentAt).toBeNull(); // legacy column untouched
  });

  it("never double-sends when many passes run at the same time (atomic claim)", async () => {
    const s = await newStudent();
    await newBooking(s.id, { hoursAhead: 23.5 });
    // Slow mail so overlapping passes really interleave between their SELECT and their claim.
    sendMail.mockImplementation(() => new Promise((r) => setTimeout(() => r({}), 30)));

    // Open all pool connections first so the passes' SELECTs really run in parallel.
    await Promise.all(Array.from({ length: 8 }, () => pool.query("select pg_sleep(0.05)")));

    const results = await Promise.all(Array.from({ length: 8 }, () => runReminderPass(fastify, { now: new Date() })));

    expect(mailsTo(s.email)).toHaveLength(1);
    expect(results.reduce((n, r) => n + r.sent24h, 0)).toBe(1);
  });

  it("claims BEFORE sending: a pass that starts while the mail is in flight sees the flag", async () => {
    const s = await newStudent();
    await newBooking(s.id, { hoursAhead: 23.5 });
    let inner: Awaited<ReturnType<typeof runReminderPass>> | undefined;
    sendMail.mockImplementationOnce(async () => {
      inner = await runReminderPass(fastify, { now: new Date() });
      return {};
    });

    await runReminderPass(fastify, { now: new Date() });

    expect(inner).toMatchObject({ sent24h: 0, sent1h: 0 });
    expect(mailsTo(s.email)).toHaveLength(1);
  });

  it("sends the 1h reminder later, independently of the 24h flag", async () => {
    const s = await newStudent();
    const id = await newBooking(s.id, { hoursAhead: 0.5, reminder24hSentAt: new Date(Date.now() - 23 * H) });

    const out = await runReminderPass(fastify, { now: new Date() });

    expect(out).toMatchObject({ sent24h: 0, sent1h: 1 });
    const mails = mailsTo(s.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("Tu clase empieza en 1 hora");
    expect((await row(id)).reminder1hSentAt).not.toBeNull();
  });

  it("skips the 24h reminder when the student booked after the 24h mark", async () => {
    const s = await newStudent();
    const id = await newBooking(s.id, { hoursAhead: 23.5, createdHoursAgo: 0.1 });

    const out = await runReminderPass(fastify, { now: new Date() });

    expect(out.sent24h).toBe(0);
    expect(mailsTo(s.email)).toHaveLength(0);
    expect((await row(id)).reminder24hSentAt).toBeNull(); // mark nothing
  });

  it.each(["cancelled", "pending", "completed", "no_show"] as const)("never reminds a %s booking", async (status) => {
    const s = await newStudent();
    await newBooking(s.id, { hoursAhead: 23.5, status });
    await newBooking(s.id, { hoursAhead: 0.5, status });

    await runReminderPass(fastify, { now: new Date() });

    expect(mailsTo(s.email)).toHaveLength(0);
  });

  it("does not remind past the catch-up grace or after the class started", async () => {
    const s = await newStudent();
    await newBooking(s.id, { hoursAhead: 18 }); // 24h window closed 4h ago
    await newBooking(s.id, { hoursAhead: -0.2 }); // already started

    await runReminderPass(fastify, { now: new Date() });

    expect(mailsTo(s.email)).toHaveLength(0);
  });

  it("picks the template from accounts.locale and escapes the student name", async () => {
    const es = await newStudent("es", "Ana");
    const en = await newStudent("en", "<b>x</b>");
    await newBooking(es.id, { hoursAhead: 23.5 });
    await newBooking(en.id, { hoursAhead: 23.5 });

    await runReminderPass(fastify, { now: new Date() });

    const [mEs] = mailsTo(es.email);
    const [mEn] = mailsTo(en.email);
    expect(mEs.subject).toMatch(/^Recordatorio de tu clase: /);
    expect(mEs.html).toContain("Hola Ana");
    expect(mEn.subject).toMatch(/^Class reminder: /);
    expect(mEn.html).toContain("Hi &lt;b&gt;x&lt;/b&gt;");
    expect(mEn.html).not.toContain("<b>x</b>");
    expect(mEn.text).toBeTruthy();
  });

  it("clears the claim when the mailer fails so the next pass retries", async () => {
    const s = await newStudent();
    const id = await newBooking(s.id, { hoursAhead: 23.5 });
    sendMail.mockRejectedValueOnce(new Error("smtp down"));

    const failed = await runReminderPass(fastify, { now: new Date() });
    expect(failed).toMatchObject({ sent24h: 0, failed: 1 });
    expect((await row(id)).reminder24hSentAt).toBeNull();

    const retry = await runReminderPass(fastify, { now: new Date() });
    expect(retry).toMatchObject({ sent24h: 1, failed: 0 });
    expect((await row(id)).reminder24hSentAt).not.toBeNull();
    expect(mailsTo(s.email)).toHaveLength(2); // one failed attempt + one success
  });

  it("keeps a failed reminder retryable only inside its window", async () => {
    const s = await newStudent();
    const id = await newBooking(s.id, { hoursAhead: 23.5 });
    sendMail.mockRejectedValue(new Error("smtp down"));

    await runReminderPass(fastify, { now: new Date() });
    // 3 hours later the 24h window (nominal + 2h grace) is over: no further attempt
    sendMail.mockClear();
    const late = await runReminderPass(fastify, { now: new Date(Date.now() + 3 * H) });

    expect(late.failed).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect((await row(id)).reminder24hSentAt).toBeNull();
  });

  it("dryRun reports what would be sent without claiming or sending", async () => {
    const s = await newStudent("en");
    const id = await newBooking(s.id, { hoursAhead: 23.5 });

    const out = await runReminderPass(fastify, { now: new Date(), dryRun: true });

    expect(out.dryRun).toBe(true);
    expect(out).toMatchObject({ sent24h: 0, sent1h: 0, failed: 0 });
    expect(out.wouldSend).toContainEqual({ bookingId: id, kind: "24h", locale: "en" });
    expect(sendMail).not.toHaveBeenCalled();
    expect((await row(id)).reminder24hSentAt).toBeNull();
  });

  it("does not remind suspended or inactive students", async () => {
    const s = await newStudent();
    await db.update(accounts).set({ status: "suspended", isActive: false }).where(eq(accounts.id, s.id));
    await newBooking(s.id, { hoursAhead: 23.5 });

    await runReminderPass(fastify, { now: new Date() });

    expect(mailsTo(s.email)).toHaveLength(0);
  });

  describe("admin endpoints", () => {
    const admin = { "x-user": "00000000-0000-0000-0000-000000000001", "x-role": "admin" };

    it("POST /admin/reminders/run requires admin", async () => {
      const res = await fastify.inject({ method: "POST", url: "/admin/reminders/run", headers: { "x-user": admin["x-user"], "x-role": "user" }, payload: {} });
      expect(res.statusCode).toBe(403);
    });

    it("POST /admin/reminders/run with dryRun returns the summary and sends nothing", async () => {
      const s = await newStudent();
      await newBooking(s.id, { hoursAhead: 23.5 });
      const res = await fastify.inject({ method: "POST", url: "/admin/reminders/run", headers: admin, payload: { dryRun: true } });
      expect(res.statusCode).toBe(200);
      const body = res.json().data;
      expect(body).toMatchObject({ dryRun: true, sent24h: 0, sent1h: 0, failed: 0 });
      expect(body.checked).toBeGreaterThanOrEqual(1);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it("POST /admin/reminders/run without body really runs", async () => {
      const s = await newStudent();
      await newBooking(s.id, { hoursAhead: 23.5 });
      const res = await fastify.inject({ method: "POST", url: "/admin/reminders/run", headers: admin });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ dryRun: false, sent24h: 1 });
      expect(mailsTo(s.email)).toHaveLength(1);
    });

    it("POST /admin/reminders/run rejects a non-boolean dryRun", async () => {
      const res = await fastify.inject({ method: "POST", url: "/admin/reminders/run", headers: admin, payload: { dryRun: "yes" } });
      expect(res.statusCode).toBe(400);
    });

    it("GET /admin/reminders/upcoming lists the next 48h with masked emails and reminder states", async () => {
      const s = await newStudent("en");
      const sent = await newBooking(s.id, { hoursAhead: 30 });
      const soon = await newBooking(s.id, { hoursAhead: 23.5, reminder24hSentAt: new Date() });
      const far = await newBooking(s.id, { hoursAhead: 60 });
      await newBooking(s.id, { hoursAhead: 10, status: "cancelled" });

      const res = await fastify.inject({ method: "GET", url: "/admin/reminders/upcoming", headers: admin });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as any[];
      const ids = data.map((d) => d.bookingId);
      expect(ids).toContain(sent);
      expect(ids).toContain(soon);
      expect(ids).not.toContain(far);
      const item = data.find((d) => d.bookingId === soon);
      expect(item.studentEmail).toBe(`${TAG.slice(0, 1)}***@hub.test`);
      expect(JSON.stringify(item)).not.toContain(s.email);
      expect(item).toMatchObject({ locale: "en", reminder24h: { state: "sent" }, reminder1h: { state: "pending" } });
      expect(item.reminder24h.sentAt).toBeTruthy();
      expect(data.find((d) => d.bookingId === sent)).toMatchObject({ reminder24h: { state: "pending" } });
      // ordered by start time
      const times = data.map((d) => new Date(d.startsAt).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it("GET /admin/reminders/upcoming requires admin", async () => {
      const res = await fastify.inject({ method: "GET", url: "/admin/reminders/upcoming", headers: { "x-user": admin["x-user"], "x-role": "user" } });
      expect(res.statusCode).toBe(403);
    });
  });
});
