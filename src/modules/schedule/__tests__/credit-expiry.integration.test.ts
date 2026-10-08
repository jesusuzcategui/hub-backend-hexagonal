// DB-backed tests for the rule "a class may only be booked on or before the expiry of the credit that
// pays for it" (single booking, series, reschedule, admin on behalf of a student). They NEVER touch
// DATABASE_URL: they only run when CREDITS_IT_DATABASE_URL points at a throwaway database whose name ends with _it.
//   CREDITS_IT_DATABASE_URL=postgres://postgres:x@localhost:5433/hub_x_it pnpm exec vitest run --no-file-parallelism credit-expiry.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { asc, eq, inArray } from "drizzle-orm";
import { createDrizzle } from "../../../db";
import { accounts } from "../../../db/schema/users";
import { products } from "../../../db/schema/ecommerce";
import { bookingSeries, bookings, classCredits, weeklySlots } from "../../../db/schema/scheduling";
import { AppError, appErrorBody } from "../../../lib/errors";
import { scheduleRoutes } from "../schedule.routes";
import { adminRoutes } from "../../admin/admin.routes";

const DB_URL = process.env.CREDITS_IT_DATABASE_URL;
const dbName = DB_URL ? new URL(DB_URL).pathname.slice(1) : "";
if (DB_URL && !/_it$/.test(dbName)) {
  throw new Error(`Refusing to run credit expiry tests against database "${dbName}"`);
}

const H = 3_600_000;
const DAY = 24 * H;
const TAG = `cexp_${Date.now()}`;

/** Bogota calendar date (YYYY-MM-DD) `offsetDays` from today. */
function bogotaDate(offsetDays: number): string {
  return new Date(Date.now() - 5 * H + offsetDays * DAY).toISOString().slice(0, 10);
}
const dowOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** The instant `hh`:00 Bogota on a Bogota calendar date. */
const at = (date: string, hh: number) => new Date(`${date}T${String(hh).padStart(2, "0")}:00:00-05:00`);

describe.skipIf(!DB_URL)("class date vs credit expiry (throwaway DB)", () => {
  let pool: Pool;
  let db: ReturnType<typeof createDrizzle>;
  let fastify: FastifyInstance;
  let productId: string;
  let teacherId: string;
  let adminId: string;
  let deactivatedSlotIds: string[] = [];
  const slotByDow = new Map<number, string>();
  const ownSlotIds: string[] = [];
  const accountIds: string[] = [];
  let seq = 0;

  async function newStudent() {
    const [a] = await db
      .insert(accounts)
      .values({ email: `${TAG}_s${seq++}@hub.test`, displayName: "IT Student", role: "user", locale: "en" })
      .returning({ id: accounts.id });
    accountIds.push(a.id);
    return a.id;
  }

  /** A credit block; `expiresAt` null = never expires. */
  async function addBlock(userId: string, total: number, expiresAt: Date | null, createdDaysAgo = 1) {
    const [c] = await db
      .insert(classCredits)
      .values({ userId, productId, totalCredits: total, usedCredits: 0, expiresAt, createdAt: new Date(Date.now() - createdDaysAgo * DAY) })
      .returning({ id: classCredits.id });
    return c.id;
  }

  const used = async (creditId: string) => (await db.select().from(classCredits).where(eq(classCredits.id, creditId)))[0].usedCredits;
  const headers = (id: string, role = "user") => ({ "x-user": id, "x-role": role });

  async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, who: string, payload?: unknown, role = "user", extra: Record<string, string> = {}) {
    const res = await fastify.inject({ method, url, headers: { ...headers(who, role), ...extra }, payload: payload as any });
    return { status: res.statusCode, body: res.json() as any, headers: res.headers };
  }

  /** Composite slot id of the 06:00 / `hh`:00 chunk on a Bogota calendar date. */
  function sidOn(date: string, hh = "06") {
    return `${slotByDow.get(dowOf(date))}_${date.replace(/-/g, "")}_${hh}00`;
  }

  const book = (studentId: string, slotId: string, creditId?: string) => call("POST", "/schedule/book", studentId, { slotId, creditId });

  function expectExpiryError(r: { status: number; body: any }) {
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("CLASS_AFTER_CREDIT_EXPIRY");
    expect(typeof r.body.error.message).toBe("string");
    return r.body.error.details as Record<string, string>;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    db = createDrizzle(pool);
    fastify = Fastify();
    fastify.decorate("drizzle", db);
    fastify.decorate("mailer", { sendMail: vi.fn().mockResolvedValue({}) } as any);
    fastify.decorate("caldav", { createEvent: vi.fn().mockResolvedValue(undefined), deleteEvent: vi.fn().mockResolvedValue(undefined) } as any);
    fastify.decorate("authenticate", async (req: any) => {
      req.user = { sub: req.headers["x-user"], role: req.headers["x-role"] ?? "user" };
    });
    fastify.setErrorHandler((error: any, _req, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(appErrorBody(error));
      return reply.status(500).send({ error: error.message });
    });
    await fastify.register(scheduleRoutes);
    await fastify.register(adminRoutes);
    await fastify.ready();

    const active = await db.select({ id: weeklySlots.id }).from(weeklySlots).where(eq(weeklySlots.isActive, true));
    deactivatedSlotIds = active.map((s) => s.id);
    if (deactivatedSlotIds.length) await db.update(weeklySlots).set({ isActive: false }).where(inArray(weeklySlots.id, deactivatedSlotIds));

    const [t] = await db
      .insert(accounts)
      .values({ email: `${TAG}_teacher@hub.test`, displayName: "IT Teacher", role: "admin" })
      .returning({ id: accounts.id });
    teacherId = t.id;
    adminId = t.id;
    accountIds.push(t.id);
    // 06:00-22:00 so there are chunks AFTER a morning expiry instant on the expiry day.
    for (let dow = 0; dow < 7; dow++) {
      const [s] = await db
        .insert(weeklySlots)
        .values({ teacherId, dayOfWeek: dow, startTime: "06:00", endTime: "22:00", isActive: true })
        .returning({ id: weeklySlots.id });
      ownSlotIds.push(s.id);
      slotByDow.set(dow, s.id);
    }

    const [p] = await db
      .insert(products)
      .values({ externalId: `${TAG}_p`, contentType: "nodus_product", slug: `${TAG}-p`, name: "IT Plan", metadata: {} })
      .returning({ id: products.id });
    productId = p.id;
  });

  beforeEach(async () => {
    await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
    await db.delete(bookingSeries).where(inArray(bookingSeries.studentId, accountIds));
    await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
  });

  afterAll(async () => {
    if (!pool) return;
    await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
    await db.delete(bookingSeries).where(inArray(bookingSeries.studentId, accountIds));
    await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    await db.delete(weeklySlots).where(inArray(weeklySlots.id, ownSlotIds));
    if (deactivatedSlotIds.length) await db.update(weeklySlots).set({ isActive: true }).where(inArray(weeklySlots.id, deactivatedSlotIds));
    await db.delete(products).where(eq(products.id, productId));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
    await fastify.close();
    await pool.end();
  });

  // ---------------------------------------------------------------------------------------------
  describe("POST /schedule/book", () => {
    it("books a class ON the expiry day, even at an hour after the expiry instant", async () => {
      const s = await newStudent();
      const expiryDay = bogotaDate(5);
      const credit = await addBlock(s, 3, at(expiryDay, 9)); // expires 09:00 Bogota
      const r = await book(s, sidOn(expiryDay, "20")); // class 20:00, after the instant
      expect(r.status).toBe(201);
      expect(await used(credit)).toBe(1);
    });

    it("rejects the day after the expiry day: 409 CLASS_AFTER_CREDIT_EXPIRY with latestCreditExpiry + classStartsAt; nothing is charged", async () => {
      const s = await newStudent();
      const credit = await addBlock(s, 3, at(bogotaDate(5), 9));
      const day = bogotaDate(6);
      const details = expectExpiryError(await book(s, sidOn(day, "06")));
      expect(details.latestCreditExpiry).toBe(at(bogotaDate(5), 9).toISOString());
      expect(details.classStartsAt).toBe(at(day, 6).toISOString());
      expect(details).not.toHaveProperty("creditExpiresAt");
      expect(await used(credit)).toBe(0);
      expect(await db.select().from(bookings).where(eq(bookings.studentId, s))).toHaveLength(0);
    });

    it("explicit creditId that expires before the class: details carry creditExpiresAt", async () => {
      const s = await newStudent();
      const credit = await addBlock(s, 3, at(bogotaDate(5), 9));
      await addBlock(s, 3, at(bogotaDate(30), 9)); // a covering block exists, but the caller named this one
      const details = expectExpiryError(await book(s, sidOn(bogotaDate(8)), credit));
      expect(details.creditExpiresAt).toBe(at(bogotaDate(5), 9).toISOString());
      expect(details.classStartsAt).toBe(at(bogotaDate(8), 6).toISOString());
      expect(details).not.toHaveProperty("latestCreditExpiry");
    });

    it("two blocks: the earliest-expiring one that covers the date pays; the other date goes to the later block", async () => {
      const s = await newStudent();
      const early = await addBlock(s, 3, at(bogotaDate(5), 9), 20);
      const late = await addBlock(s, 3, at(bogotaDate(20), 9), 10);
      const near = await book(s, sidOn(bogotaDate(3)));
      expect(near.status).toBe(201);
      expect([await used(early), await used(late)]).toEqual([1, 0]);
      const far = await book(s, sidOn(bogotaDate(12)));
      expect(far.status).toBe(201);
      expect([await used(early), await used(late)]).toEqual([1, 1]);
      // beyond both -> latest expiry of the two
      const details = expectExpiryError(await book(s, sidOn(bogotaDate(25))));
      expect(details.latestCreditExpiry).toBe(at(bogotaDate(20), 9).toISOString());
    });

    it("refund goes back to the block that originally paid", async () => {
      const s = await newStudent();
      const early = await addBlock(s, 3, at(bogotaDate(5), 9), 20);
      const late = await addBlock(s, 3, at(bogotaDate(20), 9), 10);
      const far = await book(s, sidOn(bogotaDate(12)));
      expect(await used(late)).toBe(1);
      const del = await call("DELETE", `/schedule/my/${far.body.data.bookingId}`, s);
      expect(del.status).toBe(200);
      expect([await used(early), await used(late)]).toEqual([0, 0]);
    });

    it("a never-expiring credit does not limit the date", async () => {
      const s = await newStudent();
      const credit = await addBlock(s, 2, null);
      expect((await book(s, sidOn(bogotaDate(200)))).status).toBe(201);
      expect(await used(credit)).toBe(1);
    });

    it("a dated block that covers beats nothing: never-expiring block pays only when the dated one cannot cover", async () => {
      const s = await newStudent();
      const dated = await addBlock(s, 2, at(bogotaDate(5), 9));
      const never = await addBlock(s, 2, null);
      await book(s, sidOn(bogotaDate(3)));
      await book(s, sidOn(bogotaDate(9)));
      expect([await used(dated), await used(never)]).toEqual([1, 1]);
    });

    it("no usable block at all keeps the existing codes", async () => {
      const s = await newStudent();
      expect((await book(s, sidOn(bogotaDate(3)))).body.error.code).toBe("NO_CREDITS");
      await addBlock(s, 2, new Date(Date.now() - DAY));
      expect((await book(s, sidOn(bogotaDate(3)))).body.error.code).toBe("CREDITS_EXPIRED");
    });

    it("admin booking on behalf of a student follows the same rule", async () => {
      const s = await newStudent();
      await addBlock(s, 2, at(bogotaDate(5), 9));
      const bad = await call("POST", `/admin/students/${s}/book`, adminId, { slotId: sidOn(bogotaDate(7)) }, "admin");
      expectExpiryError(bad);
      const ok = await call("POST", `/admin/students/${s}/book`, adminId, { slotId: sidOn(bogotaDate(5), "20") }, "admin");
      expect(ok.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("reschedule", () => {
    async function bookedOn(studentId: string, date: string) {
      const r = await book(studentId, sidOn(date));
      expect(r.status).toBe(201);
      return r.body.data.bookingId as string;
    }

    it("rejects a new date after the paying credit's expiry (student) and keeps the old booking", async () => {
      const s = await newStudent();
      const early = await addBlock(s, 2, at(bogotaDate(6), 9), 20);
      await addBlock(s, 2, at(bogotaDate(40), 9), 10); // another block would cover, but THIS booking is paid by `early`
      const id = await bookedOn(s, bogotaDate(3));
      const r = await call("PATCH", `/schedule/my/${id}/reschedule`, s, { newSlotId: sidOn(bogotaDate(9)) });
      const details = expectExpiryError(r);
      expect(details.creditExpiresAt).toBe(at(bogotaDate(6), 9).toISOString());
      const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
      expect(row.status).toBe("confirmed");
      expect(await used(early)).toBe(1);
    });

    it("accepts a new date within the credit's expiry (including the expiry day) and keeps the same credit", async () => {
      const s = await newStudent();
      const early = await addBlock(s, 2, at(bogotaDate(6), 9), 20);
      const id = await bookedOn(s, bogotaDate(3));
      const r = await call("PATCH", `/schedule/my/${id}/reschedule`, s, { newSlotId: sidOn(bogotaDate(6), "20") });
      expect(r.status).toBe(200);
      const [old] = await db.select().from(bookings).where(eq(bookings.id, id));
      const [moved] = await db.select().from(bookings).where(eq(bookings.id, r.body.data.bookingId));
      expect(old.status).toBe("cancelled");
      expect(moved.creditId).toBe(early);
      expect(await used(early)).toBe(1);
    });

    it("admin reschedule is bound by the same rule", async () => {
      const s = await newStudent();
      await addBlock(s, 2, at(bogotaDate(6), 9));
      const id = await bookedOn(s, bogotaDate(3));
      expectExpiryError(await call("PATCH", `/admin/bookings/${id}/reschedule`, adminId, { newSlotId: sidOn(bogotaDate(9)) }, "admin"));
      expect((await call("PATCH", `/admin/bookings/${id}/reschedule`, adminId, { newSlotId: sidOn(bogotaDate(5)) }, "admin")).status).toBe(200);
    });

    it("a booking paid by a never-expiring credit can move anywhere", async () => {
      const s = await newStudent();
      await addBlock(s, 2, null);
      const id = await bookedOn(s, bogotaDate(3));
      expect((await call("PATCH", `/schedule/my/${id}/reschedule`, s, { newSlotId: sidOn(bogotaDate(300)) })).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("series", () => {
    // Weekly on the weekday of `start`, 06:00. Occurrence i is on start + 7*i days.
    const startOffset = 3;
    const start = () => bogotaDate(startOffset);
    const occDate = (i: number) => bogotaDate(startOffset + 7 * i);
    const rule = (occurrences: number, over: Record<string, unknown> = {}) => ({
      pattern: [{ weekday: dowOf(start()), time: "06:00" }],
      intervalWeeks: 1,
      startDate: start(),
      occurrences,
      ...over,
    });
    const seriesBookings = (studentId: string) => db.select().from(bookings).where(eq(bookings.studentId, studentId)).orderBy(asc(bookings.startsAt));

    it("preview marks occurrences after the expiry day and exposes latestCreditExpiry; required/sufficient follow the bookable ones", async () => {
      const s = await newStudent();
      const expiry = at(occDate(1), 5); // 2nd occurrence's day, an hour BEFORE the class: still covered (inclusive)
      await addBlock(s, 3, expiry);
      const r = await call("POST", "/schedule/series/preview", s, rule(4));
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d.occurrences.map((o: any) => o.status)).toEqual(["ok", "ok", "after_credit_expiry", "after_credit_expiry"]);
      expect(d.latestCreditExpiry).toBe(expiry.toISOString());
      expect(d.required).toBe(2);
      expect(d.balance).toBe(3);
      expect(d.sufficientCredits).toBe(true);
    });

    it("preview: latestCreditExpiry is null for a never-expiring credit, and insufficient stays a balance problem", async () => {
      const s = await newStudent();
      await addBlock(s, 2, null);
      const d = (await call("POST", "/schedule/series/preview", s, rule(4))).body.data;
      expect(d.latestCreditExpiry).toBeNull();
      expect(d.occurrences.every((o: any) => o.status === "ok")).toBe(true);
      expect(d.required).toBe(4);
      expect(d.sufficientCredits).toBe(false);
    });

    it("create without skipConflicts: 409 SERIES_CONFLICTS listing after_credit_expiry; nothing is created or charged", async () => {
      const s = await newStudent();
      const credit = await addBlock(s, 4, at(occDate(1), 5));
      const r = await call("POST", "/schedule/series", s, rule(4));
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("SERIES_CONFLICTS");
      expect(r.body.error.details.occurrences.map((o: any) => o.status)).toEqual(["ok", "ok", "after_credit_expiry", "after_credit_expiry"]);
      expect(await used(credit)).toBe(0);
      expect(await seriesBookings(s)).toHaveLength(0);
    });

    it("create with skipConflicts: books the covered ones, reports the rest in skipped; balance stays consistent", async () => {
      const s = await newStudent();
      const credit = await addBlock(s, 4, at(occDate(1), 5));
      const r = await call("POST", "/schedule/series", s, { ...rule(4), skipConflicts: true });
      expect(r.status).toBe(201);
      const d = r.body.data;
      expect(d.created).toBe(2);
      expect(d.creditsUsed).toBe(2);
      expect(d.balanceAfter).toBe(2);
      expect(d.skipped.map((o: any) => o.status)).toEqual(["after_credit_expiry", "after_credit_expiry"]);
      expect(d.skipped.map((o: any) => o.startsAt)).toEqual([at(occDate(2), 6).toISOString(), at(occDate(3), 6).toISOString()]);
      expect(await used(credit)).toBe(2);
      expect(await seriesBookings(s)).toHaveLength(2);
    });

    it("everything past the expiry: 409 SERIES_CONFLICTS even with skipConflicts (nothing to create)", async () => {
      const s = await newStudent();
      await addBlock(s, 4, at(bogotaDate(1), 5));
      const r = await call("POST", "/schedule/series", s, { ...rule(3), skipConflicts: true });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("SERIES_CONFLICTS");
      expect(r.body.error.details.occurrences.map((o: any) => o.status)).toEqual(["after_credit_expiry", "after_credit_expiry", "after_credit_expiry"]);
    });

    it("Idempotency-Key replay returns the stored response, with the new status in skipped, and charges nothing twice", async () => {
      const s = await newStudent();
      const credit = await addBlock(s, 4, at(occDate(1), 5));
      const key = `${TAG}-idem-1`;
      const body = { ...rule(4), skipConflicts: true };
      const first = await call("POST", "/schedule/series", s, body, "user", { "idempotency-key": key });
      expect(first.status).toBe(201);
      const second = await call("POST", "/schedule/series", s, body, "user", { "idempotency-key": key });
      expect(second.status).toBe(200);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(second.body.data).toEqual(first.body.data);
      expect(second.body.data.skipped.map((o: any) => o.status)).toEqual(["after_credit_expiry", "after_credit_expiry"]);
      expect(await used(credit)).toBe(2);
      expect(await seriesBookings(s)).toHaveLength(2);
    });

    it("two blocks with different expiries: allocation is per occurrence; refunds go to the original block", async () => {
      const s = await newStudent();
      const early = await addBlock(s, 3, at(occDate(1), 5), 20);
      const late = await addBlock(s, 5, at(occDate(10), 5), 10);
      const r = await call("POST", "/schedule/series", s, rule(5));
      expect(r.status).toBe(201);
      expect(r.body.data.created).toBe(5);
      const rows = await seriesBookings(s);
      expect(rows.map((b) => b.creditId)).toEqual([early, early, late, late, late]);
      expect([await used(early), await used(late)]).toEqual([2, 3]);
      const cancel = await call("DELETE", `/schedule/series/${r.body.data.seriesId}`, s);
      expect(cancel.status).toBe(200);
      expect([await used(early), await used(late)]).toEqual([0, 0]);
    });

    it("the early block's leftover credit does not pay for a date it does not cover", async () => {
      const s = await newStudent();
      const early = await addBlock(s, 5, at(occDate(0), 5), 20); // covers only the first occurrence
      const late = await addBlock(s, 5, at(occDate(10), 5), 10);
      const r = await call("POST", "/schedule/series", s, rule(3));
      expect(r.status).toBe(201);
      expect((await seriesBookings(s)).map((b) => b.creditId)).toEqual([early, late, late]);
    });

    it("a never-expiring credit never limits the series", async () => {
      const s = await newStudent();
      const credit = await addBlock(s, 4, null);
      const r = await call("POST", "/schedule/series", s, rule(4));
      expect(r.status).toBe(201);
      expect(r.body.data.skipped).toEqual([]);
      expect(await used(credit)).toBe(4);
    });

    it("running out of credit is still INSUFFICIENT_CREDITS (not a date problem)", async () => {
      const s = await newStudent();
      await addBlock(s, 2, at(occDate(10), 5));
      const r = await call("POST", "/schedule/series", s, rule(4));
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("admin preview and create on behalf of a student apply the same rule", async () => {
      const s = await newStudent();
      await addBlock(s, 4, at(occDate(1), 5));
      const p = await call("POST", `/admin/students/${s}/series/preview`, adminId, rule(4), "admin");
      expect(p.body.data.occurrences.map((o: any) => o.status)).toEqual(["ok", "ok", "after_credit_expiry", "after_credit_expiry"]);
      const c = await call("POST", `/admin/students/${s}/series`, adminId, { ...rule(4), skipConflicts: true }, "admin");
      expect(c.status).toBe(201);
      expect(c.body.data.created).toBe(2);
    });
  });
});
