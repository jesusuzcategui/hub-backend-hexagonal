// DB-backed tests for recurring class series. They NEVER touch DATABASE_URL: they only run when
// SERIES_IT_DATABASE_URL points at a throwaway database whose name ends with _it, _test, _rem or
// _ser. Mailer and CalDAV are always mocks; no real email is sent and no CalDAV call is made.
//   SERIES_IT_DATABASE_URL=postgres://postgres:x@localhost:5433/hub_ser pnpm exec vitest run series.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createDrizzle } from "../../../db";
import { accounts } from "../../../db/schema/users";
import { products } from "../../../db/schema/ecommerce";
import { bookingSeries, bookings, classCredits, weeklySlots } from "../../../db/schema/scheduling";
import { AppError, appErrorBody } from "../../../lib/errors";
import { scheduleRoutes } from "../schedule.routes";
import { adminRoutes } from "../../admin/admin.routes";
import { createStudentBooking } from "../schedule.service";
import { cancelSeries, createSeries, listSeries, previewSeries } from "../series.service";
import { generateOccurrences, validateSeriesRule } from "../series";
import { runReminderPass } from "../reminders.service";

const DB_URL = process.env.SERIES_IT_DATABASE_URL;
const dbName = DB_URL ? new URL(DB_URL).pathname.slice(1) : "";
if (DB_URL && !/(_it|_test|_rem|_ser)$/.test(dbName)) {
  throw new Error(`Refusing to run series integration tests against database "${dbName}"`);
}

const H = 3_600_000;
const DAY = 24 * H;
const TAG = `serit_${Date.now()}`;

function bogotaDate(offsetDays: number): string {
  return new Date(Date.now() - 5 * H + offsetDays * DAY).toISOString().slice(0, 10);
}
/** First Monday (Bogota) at least 3 days ahead, so no occurrence is inside the 24h window. */
function startMonday(): string {
  for (let d = 3; d < 12; d++) {
    const date = bogotaDate(d);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) return date;
  }
  throw new Error("unreachable");
}

const monWed8 = (over: Record<string, unknown> = {}) => ({
  pattern: [{ weekday: 1, time: "06:00" }, { weekday: 3, time: "06:00" }],
  intervalWeeks: 1,
  startDate: startMonday(),
  occurrences: 8,
  ...over,
});

describe.skipIf(!DB_URL)("booking series (throwaway DB)", () => {
  let pool: Pool;
  let db: ReturnType<typeof createDrizzle>;
  let fastify: FastifyInstance;
  let sendMail: ReturnType<typeof vi.fn>;
  let createEvent: ReturnType<typeof vi.fn>;
  let deleteEvent: ReturnType<typeof vi.fn>;
  let productId: string;
  let teacherId: string;
  let deactivatedSlotIds: string[] = [];
  const ownSlotIds: string[] = [];
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

  async function addBlock(userId: string, total: number, expiresInDays: number | null, createdDaysAgo = 1) {
    const [c] = await db
      .insert(classCredits)
      .values({
        userId,
        productId,
        totalCredits: total,
        usedCredits: 0,
        expiresAt: expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY),
        createdAt: new Date(Date.now() - createdDaysAgo * DAY),
      })
      .returning({ id: classCredits.id });
    return c.id;
  }

  const used = async (creditId: string) => (await db.select().from(classCredits).where(eq(classCredits.id, creditId)))[0].usedCredits;
  const seriesBookings = (seriesId: string) =>
    db.select().from(bookings).where(eq(bookings.seriesId, seriesId)).orderBy(asc(bookings.startsAt));
  const studentBookings = (studentId: string) => db.select().from(bookings).where(eq(bookings.studentId, studentId));
  const seriesRows = (studentId: string) => db.select().from(bookingSeries).where(eq(bookingSeries.studentId, studentId));
  const asUser = (id: string, role = "user") => ({ "x-user": id, "x-role": role });
  const mailsTo = (email: string) => sendMail.mock.calls.map((c) => c[0]).filter((m) => m.to === email);

  async function expectAppError(p: Promise<unknown>, status: number, code: string) {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(status);
      expect((err as AppError).code).toBe(code);
      return err as AppError;
    }
    throw new Error(`expected AppError ${code}`);
  }

  async function newSlot(dayOfWeek: number, startTime: string, endTime: string) {
    const [s] = await db
      .insert(weeklySlots)
      .values({ teacherId, dayOfWeek, startTime, endTime, isActive: true })
      .returning({ id: weeklySlots.id });
    ownSlotIds.push(s.id);
    return s.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    db = createDrizzle(pool);
    sendMail = vi.fn().mockResolvedValue({});
    createEvent = vi.fn().mockResolvedValue(undefined);
    deleteEvent = vi.fn().mockResolvedValue(undefined);
    fastify = Fastify();
    fastify.decorate("drizzle", db);
    fastify.decorate("mailer", { sendMail } as any);
    fastify.decorate("caldav", { createEvent, deleteEvent } as any);
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

    // Make this suite independent of whatever weekly slots the database was seeded with.
    const active = await db.select({ id: weeklySlots.id }).from(weeklySlots).where(eq(weeklySlots.isActive, true));
    deactivatedSlotIds = active.map((s) => s.id);
    if (deactivatedSlotIds.length) await db.update(weeklySlots).set({ isActive: false }).where(inArray(weeklySlots.id, deactivatedSlotIds));

    const [t] = await db
      .insert(accounts)
      .values({ email: `${TAG}_teacher@hub.test`, displayName: "IT Teacher", role: "admin" })
      .returning({ id: accounts.id });
    teacherId = t.id;
    accountIds.push(t.id);
    await newSlot(1, "06:00", "08:00"); // Monday 06:00 + 07:00
    await newSlot(3, "06:00", "08:00"); // Wednesday 06:00 + 07:00

    const [p] = await db
      .insert(products)
      .values({ externalId: `${TAG}_p`, contentType: "nodus_product", slug: `${TAG}-p`, name: "IT Plan", metadata: {} })
      .returning({ id: products.id });
    productId = p.id;
  });

  beforeEach(async () => {
    if (accountIds.length) {
      await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
      await db.delete(bookingSeries).where(inArray(bookingSeries.studentId, accountIds));
      await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    }
    await db.update(weeklySlots).set({ isActive: true }).where(inArray(weeklySlots.id, ownSlotIds.slice(0, 2)));
    if (ownSlotIds.length > 2) await db.update(weeklySlots).set({ isActive: false }).where(inArray(weeklySlots.id, ownSlotIds.slice(2)));
    sendMail.mockReset();
    sendMail.mockResolvedValue({});
    createEvent.mockReset();
    createEvent.mockResolvedValue(undefined);
    deleteEvent.mockReset();
    deleteEvent.mockResolvedValue(undefined);
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

  describe("createSeries", () => {
    it("Monday+Wednesday 06:00 weekly x8 with 10 credits: 8 bookings, deducted across blocks in expiry order, 2 left", async () => {
      const s = await newStudent("es", "Ana");
      const soon = await addBlock(s.id, 6, 30, 5); // expires first even though created later
      const later = await addBlock(s.id, 4, 60, 9);

      const out = await createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8() });

      expect(out).toMatchObject({ requested: 8, created: 8, creditsUsed: 8, balanceAfter: 2, skipped: [] });
      expect(out.bookings).toHaveLength(8);
      const rows = await seriesBookings(out.seriesId);
      expect(rows).toHaveLength(8);
      expect(rows.every((r) => r.status === "confirmed" && r.studentId === s.id && r.meetLink)).toBe(true);
      const expected = generateOccurrences(validateSeriesRule(monWed8()), new Date());
      expect(rows.map((r) => r.startsAt.toISOString())).toEqual(expected.map((o) => o.startsAt.toISOString()));
      expect(rows.map((r) => r.creditId)).toEqual([...Array(6).fill(soon), ...Array(2).fill(later)]);
      expect(await used(soon)).toBe(6);
      expect(await used(later)).toBe(2);

      const [series] = await seriesRows(s.id);
      expect(series).toMatchObject({ studentId: s.id, createdBy: s.id, intervalWeeks: 1, requestedOccurrences: 8, createdOccurrences: 8, status: "active" });

      // side effects: one CalDAV event per occurrence, ONE summary email in the student's locale
      expect(createEvent).toHaveBeenCalledTimes(8);
      expect(new Set(createEvent.mock.calls.map((c) => c[0]))).toEqual(new Set(rows.map((r) => r.id)));
      const mails = mailsTo(s.email);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe("✅ Tus 8 clases están confirmadas");
      expect(mails[0].html.match(/<li/g)).toHaveLength(8);
      expect((await seriesBookings(out.seriesId)).every((r) => r.gcalEventId === r.id)).toBe(true);
    });

    it("an admin can create it on behalf of the student (created_by = admin)", async () => {
      const s = await newStudent();
      await addBlock(s.id, 8, 60);
      const out = await createSeries(fastify, { studentId: s.id, createdBy: teacherId, rule: monWed8({ occurrences: 2 }) });
      const [series] = await seriesRows(s.id);
      expect(series.createdBy).toBe(teacherId);
      expect(out.created).toBe(2);
    });

    it("balance 5 and 8 requested: 409 INSUFFICIENT_CREDITS, zero rows, zero credits consumed", async () => {
      const s = await newStudent();
      const block = await addBlock(s.id, 5, 60);

      const err = await expectAppError(createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8() }), 409, "INSUFFICIENT_CREDITS");

      expect(err.details).toEqual({ required: 8, balance: 5 });
      expect(await studentBookings(s.id)).toHaveLength(0);
      expect(await seriesRows(s.id)).toHaveLength(0);
      expect(await used(block)).toBe(0);
      expect(mailsTo(s.email)).toHaveLength(0);
      expect(createEvent).not.toHaveBeenCalled();
    });

    it("expired blocks do not count towards the balance", async () => {
      const s = await newStudent();
      await addBlock(s.id, 9, -1, 70); // expired yesterday
      const ok = await addBlock(s.id, 1, 60);
      const err = await expectAppError(createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8({ occurrences: 2 }) }), 409, "INSUFFICIENT_CREDITS");
      expect(err.details).toEqual({ required: 2, balance: 1 });
      expect(await used(ok)).toBe(0);
    });

    it("one conflicting occurrence with skipConflicts=false: 409 SERIES_CONFLICTS with the per-occurrence report, nothing created", async () => {
      const s = await newStudent();
      const other = await newStudent();
      const block = await addBlock(s.id, 8, 60);
      await addBlock(other.id, 1, 60);
      const rule = monWed8();
      const occ = generateOccurrences(validateSeriesRule(rule), new Date());
      // someone else holds occurrence #3 (index 2)
      await createStudentBooking(fastify, { studentId: other.id, slotId: `${(await db.select().from(weeklySlots).where(and(eq(weeklySlots.dayOfWeek, 1), eq(weeklySlots.teacherId, teacherId))))[0].id}_${occ[2].dateKey}_${occ[2].timeKey}` });
      sendMail.mockClear();

      const err = await expectAppError(createSeries(fastify, { studentId: s.id, createdBy: s.id, rule }), 409, "SERIES_CONFLICTS");

      const report = (err.details as any).occurrences as Array<{ startsAt: string; status: string }>;
      expect(report).toHaveLength(8);
      expect(report.map((r) => r.status)).toEqual(["ok", "ok", "slot_taken", "ok", "ok", "ok", "ok", "ok"]);
      expect(report[2].startsAt).toBe(occ[2].startsAt.toISOString());
      expect(await studentBookings(s.id)).toHaveLength(0);
      expect(await seriesRows(s.id)).toHaveLength(0);
      expect(await used(block)).toBe(0);
    });

    it("with skipConflicts=true the ok ones are created and the skipped ones are reported", async () => {
      const s = await newStudent();
      const other = await newStudent();
      const block = await addBlock(s.id, 8, 60);
      await addBlock(other.id, 1, 60);
      const rule = monWed8();
      const occ = generateOccurrences(validateSeriesRule(rule), new Date());
      const monSlot = (await db.select().from(weeklySlots).where(and(eq(weeklySlots.dayOfWeek, 1), eq(weeklySlots.teacherId, teacherId))))[0].id;
      await createStudentBooking(fastify, { studentId: other.id, slotId: `${monSlot}_${occ[2].dateKey}_${occ[2].timeKey}` });

      const out = await createSeries(fastify, { studentId: s.id, createdBy: s.id, rule, skipConflicts: true });

      expect(out).toMatchObject({ requested: 8, created: 7, creditsUsed: 7, balanceAfter: 1 });
      expect(out.skipped).toEqual([{ startsAt: occ[2].startsAt.toISOString(), status: "slot_taken" }]);
      expect(await used(block)).toBe(7);
      const [series] = await seriesRows(s.id);
      expect(series).toMatchObject({ requestedOccurrences: 8, createdOccurrences: 7 });
      expect((await seriesBookings(out.seriesId)).map((b) => b.startsAt.toISOString())).not.toContain(occ[2].startsAt.toISOString());
    });

    it("skipConflicts=true still returns INSUFFICIENT_CREDITS when the ok ones exceed the balance", async () => {
      const s = await newStudent();
      const block = await addBlock(s.id, 3, 60);
      const err = await expectAppError(createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8(), skipConflicts: true }), 409, "INSUFFICIENT_CREDITS");
      expect(err.details).toEqual({ required: 8, balance: 3 });
      expect(await used(block)).toBe(0);
      expect(await studentBookings(s.id)).toHaveLength(0);
    });

    it("every occurrence conflicting with skipConflicts=true creates nothing (409 SERIES_CONFLICTS)", async () => {
      const s = await newStudent();
      await addBlock(s.id, 8, 60);
      await db.update(weeklySlots).set({ isActive: false }).where(inArray(weeklySlots.id, ownSlotIds));
      const err = await expectAppError(createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8(), skipConflicts: true }), 409, "SERIES_CONFLICTS");
      expect(((err.details as any).occurrences as any[]).every((o: any) => o.status === "no_slot")).toBe(true);
      expect(await seriesRows(s.id)).toHaveLength(0);
    });

    it("two concurrent createSeries for the same slots: exactly one wins, the other gets 409 and leaks no credits", async () => {
      const a = await newStudent();
      const b = await newStudent();
      const blockA = await addBlock(a.id, 8, 60);
      const blockB = await addBlock(b.id, 8, 60);
      // open pool connections so both transactions really overlap
      await Promise.all(Array.from({ length: 6 }, () => pool.query("select pg_sleep(0.05)")));

      const results = await Promise.allSettled([
        createSeries(fastify, { studentId: a.id, createdBy: a.id, rule: monWed8() }),
        createSeries(fastify, { studentId: b.id, createdBy: b.id, rule: monWed8() }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(AppError);
      expect((rejected[0].reason as AppError).statusCode).toBe(409);
      expect((rejected[0].reason as AppError).code).toBe("SERIES_CONFLICTS");

      const winnerIsA = results[0].status === "fulfilled";
      const [winner, loser, winBlock, loseBlock] = winnerIsA ? [a, b, blockA, blockB] : [b, a, blockB, blockA];
      expect(await studentBookings(winner.id)).toHaveLength(8);
      expect(await studentBookings(loser.id)).toHaveLength(0);
      expect(await used(winBlock)).toBe(8);
      expect(await used(loseBlock)).toBe(0);
      expect(await seriesRows(loser.id)).toHaveLength(0);
    });

    it("student_busy: the student already has a booking at that hour (even on another weekly slot)", async () => {
      const s = await newStudent();
      const block = await addBlock(s.id, 8, 60);
      const rule = monWed8({ occurrences: 2 });
      const occ = generateOccurrences(validateSeriesRule(rule), new Date());
      // a second weekly slot at the same Monday 06:00 holding a booking of this same student
      const second = await newSlot(1, "06:00", "07:00");
      const [mine] = await db
        .insert(bookings)
        .values({ studentId: s.id, creditId: block, productId, weeklySlotId: second, status: "confirmed", startsAt: occ[0].startsAt, endsAt: occ[0].endsAt })
        .returning({ id: bookings.id });
      await db.update(weeklySlots).set({ isActive: false }).where(eq(weeklySlots.id, second));
      const preview = await previewSeries(fastify, { studentId: s.id, rule });
      expect(preview.occurrences[0]).toEqual({ startsAt: occ[0].startsAt.toISOString(), status: "student_busy" });
      expect(mine.id).toBeTruthy();
    });

    it("single bookings now also refuse a student overlapping booking (STUDENT_BUSY)", async () => {
      const s = await newStudent();
      await addBlock(s.id, 8, 60);
      const rule = monWed8({ occurrences: 1 });
      const occ = generateOccurrences(validateSeriesRule(rule), new Date());
      const monSlot = ownSlotIds[0];
      const second = await newSlot(1, "06:00", "07:00");
      await createStudentBooking(fastify, { studentId: s.id, slotId: `${monSlot}_${occ[0].dateKey}_${occ[0].timeKey}` });
      await expectAppError(
        createStudentBooking(fastify, { studentId: s.id, slotId: `${second}_${occ[0].dateKey}_${occ[0].timeKey}` }),
        409,
        "STUDENT_BUSY",
      );
      expect(await studentBookings(s.id)).toHaveLength(1);
    });

    it("rejects invalid rules with 400 VALIDATION_ERROR and an unknown student with 404", async () => {
      const s = await newStudent();
      await addBlock(s.id, 8, 60);
      await expectAppError(createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8({ occurrences: 0 }) }), 400, "VALIDATION_ERROR");
      await expectAppError(createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8({ startDate: bogotaDate(-2) }) }), 400, "VALIDATION_ERROR");
      await expectAppError(createSeries(fastify, { studentId: teacherId, createdBy: teacherId, rule: monWed8() }), 404, "STUDENT_NOT_FOUND");
    });
  });

  describe("previewSeries", () => {
    it("returns per-occurrence status, required and balance, and writes nothing", async () => {
      const s = await newStudent();
      await addBlock(s.id, 5, 60);
      const rule = monWed8();
      const out = await previewSeries(fastify, { studentId: s.id, rule });
      expect(out).toMatchObject({ requested: 8, required: 8, balance: 5, sufficientCredits: false });
      expect(out.occurrences).toHaveLength(8);
      expect(out.occurrences.every((o) => o.status === "ok")).toBe(true);
      expect(await studentBookings(s.id)).toHaveLength(0);
      expect(await seriesRows(s.id)).toHaveLength(0);
    });
  });

  describe("cancelSeries", () => {
    async function seed8() {
      const s = await newStudent("en", "Bea");
      const soon = await addBlock(s.id, 6, 30, 5);
      const later = await addBlock(s.id, 4, 60, 9);
      const out = await createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8() });
      sendMail.mockClear();
      return { s, soon, later, out };
    }

    it("student cancel: refunds one credit per occurrence to its own block, keeps the <24h one, is idempotent", async () => {
      const { s, soon, later, out } = await seed8();
      const rows = await seriesBookings(out.seriesId);
      // make the FIRST occurrence start in 12h (its credit is from block `soon`)
      await db.update(bookings).set({ startsAt: new Date(Date.now() + 12 * H), endsAt: new Date(Date.now() + 13 * H) }).where(eq(bookings.id, rows[0].id));

      const res = await cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "student", userId: s.id } });

      expect(res).toMatchObject({ seriesId: out.seriesId, cancelled: 7, refunded: 7, status: "active" });
      expect(res.kept.map((k: { bookingId: string }) => k.bookingId)).toEqual([rows[0].id]);
      expect(await used(soon)).toBe(1); // 6 used - 5 refunded
      expect(await used(later)).toBe(0); // 2 used - 2 refunded
      const after = await seriesBookings(out.seriesId);
      expect(after.filter((r) => r.status === "cancelled")).toHaveLength(7);
      expect(after.find((r) => r.id === rows[0].id)!.status).toBe("confirmed");
      expect(deleteEvent).toHaveBeenCalledTimes(7);
      const mails = mailsTo(s.email);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe("❌ Class series cancelled");

      sendMail.mockClear();
      deleteEvent.mockClear();
      const again = await cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "student", userId: s.id } });
      expect(again).toMatchObject({ cancelled: 0, refunded: 0, status: "active" });
      expect(again.kept).toHaveLength(1);
      expect(await used(soon)).toBe(1);
      expect(await used(later)).toBe(0);
      expect(mailsTo(s.email)).toHaveLength(0);
      expect(deleteEvent).not.toHaveBeenCalled();
    });

    it("admin cancel has no cutoff, marks the series cancelled and is idempotent", async () => {
      const { s, soon, later, out } = await seed8();
      const rows = await seriesBookings(out.seriesId);
      await db.update(bookings).set({ startsAt: new Date(Date.now() + 12 * H), endsAt: new Date(Date.now() + 13 * H) }).where(eq(bookings.id, rows[0].id));

      const res = await cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "admin" } });

      expect(res).toMatchObject({ cancelled: 8, refunded: 8, status: "cancelled" });
      expect(res.kept).toEqual([]);
      expect(await used(soon)).toBe(0);
      expect(await used(later)).toBe(0);
      const [series] = await seriesRows(s.id);
      expect(series.status).toBe("cancelled");

      const again = await cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "admin" } });
      expect(again).toMatchObject({ cancelled: 0, refunded: 0, status: "cancelled" });
      expect(await used(soon)).toBe(0);
    });

    it("after a student cancel kept one, the admin cancels the rest and the series becomes cancelled", async () => {
      const { s, soon, out } = await seed8();
      const rows = await seriesBookings(out.seriesId);
      await db.update(bookings).set({ startsAt: new Date(Date.now() + 12 * H), endsAt: new Date(Date.now() + 13 * H) }).where(eq(bookings.id, rows[0].id));
      await cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "student", userId: s.id } });
      const res = await cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "admin" } });
      expect(res).toMatchObject({ cancelled: 1, refunded: 1, status: "cancelled" });
      expect(await used(soon)).toBe(0);
    });

    it("never touches past or already cancelled occurrences", async () => {
      const { s, soon, out } = await seed8();
      const rows = await seriesBookings(out.seriesId);
      await db.update(bookings).set({ startsAt: new Date(Date.now() - 3 * DAY), endsAt: new Date(Date.now() - 3 * DAY + H) }).where(eq(bookings.id, rows[0].id));
      await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, rows[1].id));
      const res = await cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "admin" } });
      expect(res.cancelled).toBe(6);
      // rows[0] (past) and rows[1] (cancelled earlier, no refund recorded by this test) stay used
      expect(await used(soon)).toBe(2);
      expect(s.id).toBeTruthy();
    });

    it("ownership: student B cannot cancel or list student A's series (404 NOT_FOUND)", async () => {
      const { out } = await seed8();
      const b = await newStudent();
      await expectAppError(cancelSeries(fastify, { seriesId: out.seriesId, actor: { role: "student", userId: b.id } }), 404, "NOT_FOUND");
      expect(await listSeries(fastify, b.id)).toEqual([]);
      expect((await seriesBookings(out.seriesId)).every((r) => r.status === "confirmed")).toBe(true);
      await expectAppError(cancelSeries(fastify, { seriesId: "00000000-0000-0000-0000-000000000000", actor: { role: "admin" } }), 404, "NOT_FOUND");
    });
  });

  describe("listSeries", () => {
    it("lists the student's series with their occurrences", async () => {
      const s = await newStudent();
      await addBlock(s.id, 8, 60);
      const out = await createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8({ occurrences: 3 }) });
      const list = await listSeries(fastify, s.id);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: out.seriesId,
        status: "active",
        intervalWeeks: 1,
        requestedOccurrences: 3,
        createdOccurrences: 3,
        pattern: [{ weekday: 1, time: "06:00" }, { weekday: 3, time: "06:00" }],
      });
      expect(list[0].occurrences).toHaveLength(3);
      expect(list[0].occurrences[0]).toMatchObject({ status: "confirmed" });
    });
  });

  describe("reminders", () => {
    it("the reminder runner picks up series occurrences like any other booking", async () => {
      const s = await newStudent();
      await addBlock(s.id, 8, 60);
      const out = await createSeries(fastify, { studentId: s.id, createdBy: s.id, rule: monWed8({ occurrences: 2 }) });
      const rows = await seriesBookings(out.seriesId);
      await db
        .update(bookings)
        .set({ startsAt: new Date(Date.now() + 23.5 * H), endsAt: new Date(Date.now() + 24.5 * H), createdAt: new Date(Date.now() - 72 * H) })
        .where(eq(bookings.id, rows[0].id));

      const dry = await runReminderPass(fastify, { now: new Date(), dryRun: true });

      expect(dry.wouldSend).toEqual([{ bookingId: rows[0].id, kind: "24h", locale: "es" }]);
    });
  });

  describe("routes", () => {

    it("student: preview, create (201), list, cancel; 409 bodies carry details", async () => {
      const s = await newStudent();
      await addBlock(s.id, 5, 60);
      const body = monWed8({ occurrences: 4 });

      const prev = await fastify.inject({ method: "POST", url: "/schedule/series/preview", headers: asUser(s.id), payload: body });
      expect(prev.statusCode).toBe(200);
      expect(prev.json().data).toMatchObject({ requested: 4, required: 4, balance: 5, sufficientCredits: true });

      const bad = await fastify.inject({ method: "POST", url: "/schedule/series", headers: asUser(s.id), payload: monWed8({ occurrences: 9 }) });
      expect(bad.statusCode).toBe(409);
      expect(bad.json()).toEqual({
        error: { code: "INSUFFICIENT_CREDITS", message: expect.any(String), details: { required: 9, balance: 5 } },
      });

      const created = await fastify.inject({ method: "POST", url: "/schedule/series", headers: asUser(s.id), payload: body });
      expect(created.statusCode).toBe(201);
      const data = created.json().data;
      expect(data).toMatchObject({ requested: 4, created: 4, creditsUsed: 4, balanceAfter: 1, skipped: [] });
      expect(data.bookings).toHaveLength(4);

      const conflict = await fastify.inject({ method: "POST", url: "/schedule/series", headers: asUser(s.id), payload: body });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe("SERIES_CONFLICTS");
      expect(conflict.json().error.details.occurrences.every((o: any) => o.status === "student_busy" || o.status === "slot_taken")).toBe(true);

      const list = await fastify.inject({ method: "GET", url: "/schedule/series", headers: asUser(s.id) });
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toHaveLength(1);

      const invalid = await fastify.inject({ method: "POST", url: "/schedule/series", headers: asUser(s.id), payload: { ...body, occurrences: 0 } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("VALIDATION_ERROR");

      const other = await newStudent();
      const forbidden = await fastify.inject({ method: "DELETE", url: `/schedule/series/${data.seriesId}`, headers: asUser(other.id) });
      expect(forbidden.statusCode).toBe(404);

      const del = await fastify.inject({ method: "DELETE", url: `/schedule/series/${data.seriesId}`, headers: asUser(s.id) });
      expect(del.statusCode).toBe(200);
      expect(del.json().data).toMatchObject({ cancelled: 4, refunded: 4, status: "cancelled", kept: [] });
    });

    it("a student cannot pass someone else's studentId in the body", async () => {
      const s = await newStudent();
      const victim = await newStudent();
      await addBlock(s.id, 2, 60);
      await addBlock(victim.id, 2, 60);
      const res = await fastify.inject({ method: "POST", url: "/schedule/series", headers: asUser(s.id), payload: { ...monWed8({ occurrences: 1 }), studentId: victim.id } });
      expect(res.statusCode).toBe(201);
      expect(await studentBookings(victim.id)).toHaveLength(0);
      expect(await studentBookings(s.id)).toHaveLength(1);
    });

    it("admin: preview/create/list for a student, cancel by series id; students get 403", async () => {
      const s = await newStudent();
      await addBlock(s.id, 8, 60);
      const admin = asUser(teacherId, "admin");
      const body = monWed8({ occurrences: 3 });

      const denied = await fastify.inject({ method: "POST", url: `/admin/students/${s.id}/series`, headers: asUser(s.id), payload: body });
      expect(denied.statusCode).toBe(403);

      const prev = await fastify.inject({ method: "POST", url: `/admin/students/${s.id}/series/preview`, headers: admin, payload: body });
      expect(prev.statusCode).toBe(200);
      expect(prev.json().data).toMatchObject({ required: 3, balance: 8 });

      const created = await fastify.inject({ method: "POST", url: `/admin/students/${s.id}/series`, headers: admin, payload: body });
      expect(created.statusCode).toBe(201);
      const seriesId = created.json().data.seriesId;
      expect((await seriesRows(s.id))[0].createdBy).toBe(teacherId);

      const list = await fastify.inject({ method: "GET", url: `/admin/students/${s.id}/series`, headers: admin });
      expect(list.json().data).toHaveLength(1);

      const del = await fastify.inject({ method: "DELETE", url: `/admin/series/${seriesId}`, headers: admin });
      expect(del.statusCode).toBe(200);
      expect(del.json().data).toMatchObject({ cancelled: 3, status: "cancelled" });

      const missing = await fastify.inject({ method: "DELETE", url: "/admin/series/00000000-0000-0000-0000-000000000000", headers: admin });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe("NOT_FOUND");
    });
  });
  describe("idempotent creation (Idempotency-Key)", () => {
    const post = (studentId: string, key: string | undefined, payload: unknown) =>
      fastify.inject({
        method: "POST",
        url: "/schedule/series",
        headers: { ...asUser(studentId), ...(key === undefined ? {} : { "idempotency-key": key }) },
        payload: payload as any,
      });
    const totalUsed = async (studentId: string) =>
      (await db.select().from(classCredits).where(eq(classCredits.userId, studentId))).reduce((n, c) => n + c.usedCredits, 0);

    it("a retry with the same key replays the original body: nothing new is created, charged, mailed or synced", async () => {
      const s = await newStudent();
      await addBlock(s.id, 10, 60);
      const body = monWed8({ occurrences: 4 });

      const first = await post(s.id, "key-retry-0001", body);
      expect(first.statusCode).toBe(201);
      expect(first.headers["idempotent-replayed"]).toBeUndefined();
      const mails = sendMail.mock.calls.length;
      const events = createEvent.mock.calls.length;

      const again = await post(s.id, "key-retry-0001", body);
      expect(again.statusCode).toBe(200);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());
      expect(again.json().data).toMatchObject({ requested: 4, created: 4, creditsUsed: 4, balanceAfter: 6 });

      expect(await seriesRows(s.id)).toHaveLength(1);
      expect(await studentBookings(s.id)).toHaveLength(4);
      expect(await totalUsed(s.id)).toBe(4);
      expect(sendMail.mock.calls.length).toBe(mails);
      expect(createEvent.mock.calls.length).toBe(events);
    });

    it("replays skipped occurrences and balanceAfter exactly, even after the balance changed", async () => {
      const s = await newStudent();
      const other = await newStudent();
      await addBlock(s.id, 10, 60);
      await addBlock(other.id, 5, 60);
      const body = { ...monWed8({ occurrences: 4 }), skipConflicts: true };
      // `other` takes the first Monday 06:00, so that occurrence is skipped for `s`.
      await createSeries(fastify, { studentId: other.id, createdBy: other.id, rule: monWed8({ occurrences: 1 }) });

      const first = await post(s.id, "key-skipped-01", body);
      expect(first.statusCode).toBe(201);
      expect(first.json().data.skipped).toHaveLength(1);
      await addBlock(s.id, 7, 60); // balance changes after the fact
      const again = await post(s.id, "key-skipped-01", body);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
    });

    it("rebuilds the replay from the bookings when the stored response is missing", async () => {
      const s = await newStudent();
      await addBlock(s.id, 10, 60);
      const body = monWed8({ occurrences: 3 });
      const first = await post(s.id, "key-rebuild-01", body);
      await db.update(bookingSeries).set({ idempotencyResponse: null }).where(eq(bookingSeries.studentId, s.id));

      const again = await post(s.id, "key-rebuild-01", body);
      expect(again.statusCode).toBe(200);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      const a = again.json().data;
      const f = first.json().data;
      expect(a).toMatchObject({ seriesId: f.seriesId, requested: 3, created: 3, creditsUsed: 3 });
      expect(a.bookings).toEqual(f.bookings);
      expect(await seriesRows(s.id)).toHaveLength(1);
    });

    it("the same key with a different body answers 409 IDEMPOTENCY_KEY_REUSED and creates nothing", async () => {
      const s = await newStudent();
      await addBlock(s.id, 20, 60);
      expect((await post(s.id, "key-reused-001", monWed8({ occurrences: 3 }))).statusCode).toBe(201);

      const different = await post(s.id, "key-reused-001", monWed8({ occurrences: 4 }));
      expect(different.statusCode).toBe(409);
      expect(different.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      const skip = await post(s.id, "key-reused-001", { ...monWed8({ occurrences: 3 }), skipConflicts: true });
      expect(skip.statusCode).toBe(409);
      expect(await seriesRows(s.id)).toHaveLength(1);
      expect(await totalUsed(s.id)).toBe(3);
    });

    it("the fingerprint ignores key order and skipConflicts:false vs absent", async () => {
      const s = await newStudent();
      await addBlock(s.id, 20, 60);
      const a = monWed8({ occurrences: 3 });
      const first = await post(s.id, "key-fprint-001", a);
      const reordered = { occurrences: 3, startDate: a.startDate, intervalWeeks: 1, skipConflicts: false, pattern: [{ time: "06:00", weekday: 1 }, { time: "06:00", weekday: 3 }] };
      const again = await post(s.id, "key-fprint-001", reordered);
      expect(again.statusCode).toBe(200);
      expect(again.json().data.seriesId).toBe(first.json().data.seriesId);
    });

    it("two parallel requests with the same key create exactly one series and charge once", async () => {
      const s = await newStudent();
      await addBlock(s.id, 10, 60);
      const body = monWed8({ occurrences: 4 });

      const [r1, r2] = await Promise.all([post(s.id, "key-parallel-01", body), post(s.id, "key-parallel-01", body)]);

      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
      expect(r1.json().data.seriesId).toBe(r2.json().data.seriesId);
      expect([r1, r2].filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(1);
      expect(await seriesRows(s.id)).toHaveLength(1);
      expect(await totalUsed(s.id)).toBe(4);
      expect(sendMail.mock.calls.length).toBe(1);
    });

    it("a failed request does not burn the key", async () => {
      const s = await newStudent();
      await addBlock(s.id, 2, 60);
      const body = monWed8({ occurrences: 4 });

      const noCredits = await post(s.id, "key-failed-0001", body);
      expect(noCredits.statusCode).toBe(409);
      expect(noCredits.json().error.code).toBe("INSUFFICIENT_CREDITS");
      expect(await seriesRows(s.id)).toHaveLength(0);

      await addBlock(s.id, 5, 60);
      const retry = await post(s.id, "key-failed-0001", body);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers["idempotent-replayed"]).toBeUndefined();
      expect(await seriesRows(s.id)).toHaveLength(1);
    });

    it("without a key the behavior is unchanged: two identical requests create two series", async () => {
      const s = await newStudent();
      await addBlock(s.id, 20, 60);
      const body = monWed8({ occurrences: 2 });
      const a = await post(s.id, undefined, body);
      expect(a.statusCode).toBe(201);
      expect(a.headers["idempotent-replayed"]).toBeUndefined();
      const b = await post(s.id, undefined, body);
      // The second one collides with the student's own bookings (same instants).
      expect(b.statusCode).toBe(409);
      expect(b.json().error.code).toBe("SERIES_CONFLICTS");
      expect((await seriesRows(s.id))[0].idempotencyKey).toBeNull();
    });

    it.each(["short", "has space 123", "bad/char/1234", "x".repeat(129), "ñandú-12345"])("rejects the invalid key %j with 400 VALIDATION_ERROR", async (key) => {
      const s = await newStudent();
      await addBlock(s.id, 5, 60);
      const res = await post(s.id, key, monWed8({ occurrences: 2 }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      expect(await seriesRows(s.id)).toHaveLength(0);
    });

    it("accepts boundary keys of 8 and 128 characters", async () => {
      const s = await newStudent();
      await addBlock(s.id, 10, 60);
      expect((await post(s.id, "A-_z0189", monWed8({ occurrences: 2 }))).statusCode).toBe(201);
      expect((await post(s.id, "k".repeat(128), monWed8({ occurrences: 2, pattern: [{ weekday: 3, time: "07:00" }] }))).statusCode).toBe(201);
    });

    it("the key is scoped per student: two students may use the same key", async () => {
      const a = await newStudent();
      const b = await newStudent();
      await addBlock(a.id, 5, 60);
      await addBlock(b.id, 5, 60);
      const body = monWed8({ occurrences: 2 });
      const ra = await post(a.id, "shared-key-001", body);
      const rb = await post(b.id, "shared-key-001", { ...body, pattern: [{ weekday: 1, time: "07:00" }, { weekday: 3, time: "07:00" }] });
      expect(ra.statusCode).toBe(201);
      expect(rb.statusCode).toBe(201);
      expect(ra.json().data.seriesId).not.toBe(rb.json().data.seriesId);
    });

    it("the database rejects a second series with the same (student, key)", async () => {
      const s = await newStudent();
      const row = { studentId: s.id, createdBy: s.id, pattern: [], intervalWeeks: 1, startDate: startMonday(), requestedOccurrences: 1, createdOccurrences: 1, idempotencyKey: "db-unique-0001", requestFingerprint: "f" };
      await db.insert(bookingSeries).values(row);
      await expect(db.insert(bookingSeries).values(row)).rejects.toThrow();
      await db.insert(bookingSeries).values({ ...row, idempotencyKey: null, requestFingerprint: null });
      await db.insert(bookingSeries).values({ ...row, idempotencyKey: null, requestFingerprint: null });
      // a key without a fingerprint is refused by the CHECK constraint
      await expect(db.insert(bookingSeries).values({ ...row, idempotencyKey: "db-unique-0002", requestFingerprint: null })).rejects.toThrow();
    });

    it("preview ignores the header", async () => {
      const s = await newStudent();
      await addBlock(s.id, 5, 60);
      const res = await fastify.inject({
        method: "POST",
        url: "/schedule/series/preview",
        headers: { ...asUser(s.id), "idempotency-key": "bad key" },
        payload: monWed8({ occurrences: 2 }),
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
