// DB-backed tests for the error contract of the booking flows: every user-reachable failure must answer the
// envelope { error: { code, message } } with a stable UPPER_SNAKE code and the right HTTP status. They NEVER touch
// DATABASE_URL: they only run when BOOKING_ERR_IT_DATABASE_URL points at a throwaway database whose name ends with _it.
//   BOOKING_ERR_IT_DATABASE_URL=postgres://postgres:x@localhost:5433/hub_err_it pnpm exec vitest run --no-file-parallelism booking-errors.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { eq, inArray } from "drizzle-orm";
import { createDrizzle } from "../../../db";
import { accounts } from "../../../db/schema/users";
import { products } from "../../../db/schema/ecommerce";
import { blockedSlots, bookings, classCredits, mentoringRequests, weeklySlots } from "../../../db/schema/scheduling";
import { AppError, appErrorBody } from "../../../lib/errors";
import { scheduleRoutes } from "../schedule.routes";
import { adminRoutes } from "../../admin/admin.routes";
import { createMentoringRequest } from "../../portfolio/portfolio.service";

const DB_URL = process.env.BOOKING_ERR_IT_DATABASE_URL;
const dbName = DB_URL ? new URL(DB_URL).pathname.slice(1) : "";
if (DB_URL && !/_it$/.test(dbName)) {
  throw new Error(`Refusing to run booking error tests against database "${dbName}"`);
}

const H = 3_600_000;
const DAY = 24 * H;
const TAG = `bker_${Date.now()}`;
const DOW_BY_NAME: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function bogotaYmd(offsetDays: number): { ymd: string; dow: number } {
  const d = new Date(Date.now() - 5 * H + offsetDays * DAY);
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  return { ymd, dow: d.getUTCDay() };
}

describe.skipIf(!DB_URL)("booking flows error codes (throwaway DB)", () => {
  let pool: Pool;
  let db: ReturnType<typeof createDrizzle>;
  let fastify: FastifyInstance;
  let productId: string;
  let teacherId: string;
  let deactivatedSlotIds: string[] = [];
  const slotByDow = new Map<number, string>();
  const ownSlotIds: string[] = [];
  const accountIds: string[] = [];
  const blockIds: string[] = [];
  let seq = 0;

  async function newStudent() {
    const n = seq++;
    const [a] = await db
      .insert(accounts)
      .values({ email: `${TAG}_s${n}@hub.test`, displayName: "IT Student", role: "user", locale: "en" })
      .returning({ id: accounts.id });
    accountIds.push(a.id);
    return a.id;
  }

  async function addBlock(userId: string, total = 5, used = 0) {
    const [c] = await db
      .insert(classCredits)
      .values({ userId, productId, totalCredits: total, usedCredits: used, expiresAt: new Date(Date.now() + 30 * DAY) })
      .returning({ id: classCredits.id });
    return c.id;
  }

  async function newSlot(dayOfWeek: number, startTime = "06:00", endTime = "08:00") {
    const [s] = await db
      .insert(weeklySlots)
      .values({ teacherId, dayOfWeek, startTime, endTime, isActive: true })
      .returning({ id: weeklySlots.id });
    ownSlotIds.push(s.id);
    return s.id;
  }

  /** Composite slot id of the chunk at `hh`:00 Bogota, `offsetDays` from now, on the weekly slot of that weekday. */
  function sid(offsetDays: number, hh = "06", weeklySlotId?: string) {
    const { ymd, dow } = bogotaYmd(offsetDays);
    return `${weeklySlotId ?? slotByDow.get(dow)}_${ymd}_${hh}00`;
  }

  const as = (id: string, role = "user") => ({ "x-user": id, "x-role": role });

  async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, who: string, payload?: unknown, role = "user") {
    const res = await fastify.inject({ method, url, headers: as(who, role), payload: payload as any });
    return { status: res.statusCode, body: res.json() as any };
  }

  function expectError(r: { status: number; body: any }, status: number, code: string) {
    expect(r.status).toBe(status);
    expect(r.body.error).toEqual(expect.objectContaining({ code, message: expect.any(String) }));
    expect(typeof r.body.error).toBe("object");
  }

  async function book(studentId: string, slotId: string, creditId?: string) {
    return call("POST", "/schedule/book", studentId, { slotId, creditId });
  }

  async function insertBooking(studentId: string, creditId: string, startsAt: Date, status: "confirmed" | "cancelled" = "confirmed") {
    const [b] = await db
      .insert(bookings)
      .values({ studentId, creditId, productId, status, startsAt, endsAt: new Date(startsAt.getTime() + H) })
      .returning({ id: bookings.id });
    return b.id;
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
    accountIds.push(t.id);
    for (let dow = 0; dow < 7; dow++) slotByDow.set(dow, await newSlot(dow));

    const [p] = await db
      .insert(products)
      .values({ externalId: `${TAG}_p`, contentType: "nodus_product", slug: `${TAG}-p`, name: "IT Plan", metadata: {} })
      .returning({ id: products.id });
    productId = p.id;
  });

  beforeEach(async () => {
    await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
    await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    if (blockIds.length) await db.delete(blockedSlots).where(inArray(blockedSlots.id, blockIds.splice(0)));
    await db.delete(mentoringRequests).where(eq(mentoringRequests.email, `${TAG}@mentor.test`));
    await db.update(weeklySlots).set({ isActive: true }).where(inArray(weeklySlots.id, ownSlotIds));
  });

  afterAll(async () => {
    if (!pool) return;
    await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
    await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    await db.delete(mentoringRequests).where(eq(mentoringRequests.email, `${TAG}@mentor.test`));
    await db.delete(weeklySlots).where(inArray(weeklySlots.id, ownSlotIds));
    if (deactivatedSlotIds.length) await db.update(weeklySlots).set({ isActive: true }).where(inArray(weeklySlots.id, deactivatedSlotIds));
    await db.delete(products).where(eq(products.id, productId));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
    await fastify.close();
    await pool.end();
  });

  async function blockAround(offsetDays: number, hh = 6) {
    const { ymd } = bogotaYmd(offsetDays);
    const startsAt = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${String(hh).padStart(2, "0")}:00:00-05:00`);
    const [b] = await db
      .insert(blockedSlots)
      .values({ teacherId, startsAt, endsAt: new Date(startsAt.getTime() + H), reason: "it" })
      .returning({ id: blockedSlots.id });
    blockIds.push(b.id);
  }

  describe("POST /schedule/book", () => {
    it("missing slotId: 400 MISSING_FIELDS", async () => {
      const s = await newStudent();
      expectError(await call("POST", "/schedule/book", s, {}), 400, "MISSING_FIELDS");
    });

    it("unknown weekly slot: 404 SLOT_NOT_FOUND", async () => {
      const s = await newStudent();
      await addBlock(s);
      const { ymd } = bogotaYmd(5);
      expectError(await book(s, `00000000-0000-4000-8000-0000000000aa_${ymd}_0600`), 404, "SLOT_NOT_FOUND");
    });

    it("unknown legacy availability: 404 SLOT_NOT_FOUND", async () => {
      const s = await newStudent();
      expectError(await book(s, "00000000-0000-4000-8000-0000000000bb"), 404, "SLOT_NOT_FOUND");
    });

    it("inactive weekly slot: 409 SLOT_NOT_AVAILABLE", async () => {
      const s = await newStudent();
      await addBlock(s);
      await db.update(weeklySlots).set({ isActive: false }).where(eq(weeklySlots.id, slotByDow.get(bogotaYmd(5).dow)!));
      expectError(await book(s, sid(5)), 409, "SLOT_NOT_AVAILABLE");
    });

    it("date that does not match the slot weekday: 400 INVALID_SLOT", async () => {
      const s = await newStudent();
      await addBlock(s);
      const wrongDow = (bogotaYmd(5).dow + 1) % 7;
      const { ymd } = bogotaYmd(5);
      expectError(await book(s, `${slotByDow.get(wrongDow)}_${ymd}_0600`), 400, "INVALID_SLOT");
    });

    it("time that is not a chunk of the slot: 400 INVALID_SLOT", async () => {
      const s = await newStudent();
      await addBlock(s);
      expectError(await book(s, sid(5, "10")), 400, "INVALID_SLOT");
    });

    it("slot in the past: 409 SLOT_IN_PAST", async () => {
      const s = await newStudent();
      await addBlock(s);
      expectError(await book(s, sid(-3)), 409, "SLOT_IN_PAST");
    });

    it("blocked slot: 409 SLOT_BLOCKED", async () => {
      const s = await newStudent();
      await addBlock(s);
      await blockAround(5);
      expectError(await book(s, sid(5)), 409, "SLOT_BLOCKED");
    });

    it("slot taken by another student: 409 SLOT_TAKEN", async () => {
      const a = await newStudent();
      const b = await newStudent();
      await addBlock(a);
      await addBlock(b);
      expect((await book(a, sid(5))).status).toBe(201);
      expectError(await book(b, sid(5)), 409, "SLOT_TAKEN");
    });

    it("student already booked at that time: 409 STUDENT_BUSY", async () => {
      const s = await newStudent();
      await addBlock(s);
      const other = await newSlot(bogotaYmd(5).dow);
      expect((await book(s, sid(5))).status).toBe(201);
      expectError(await book(s, sid(5, "06", other)), 409, "STUDENT_BUSY");
    });

    it("no credits: 409 NO_CREDITS", async () => {
      const s = await newStudent();
      expectError(await book(s, sid(5)), 409, "NO_CREDITS");
    });

    it("unknown creditId: 404 CREDIT_NOT_FOUND", async () => {
      const s = await newStudent();
      expectError(await book(s, sid(5), "00000000-0000-4000-8000-0000000000cc"), 404, "CREDIT_NOT_FOUND");
    });
  });

  describe("DELETE /schedule/my/:id", () => {
    it("unknown booking: 404 BOOKING_NOT_FOUND", async () => {
      const s = await newStudent();
      expectError(await call("DELETE", "/schedule/my/00000000-0000-4000-8000-0000000000dd", s), 404, "BOOKING_NOT_FOUND");
    });

    it("someone else's booking is also BOOKING_NOT_FOUND (no existence leak)", async () => {
      const a = await newStudent();
      const b = await newStudent();
      const credit = await addBlock(a);
      const id = await insertBooking(a, credit, new Date(Date.now() + 5 * DAY));
      expectError(await call("DELETE", `/schedule/my/${id}`, b), 404, "BOOKING_NOT_FOUND");
    });

    it("already cancelled: 409 BOOKING_NOT_CANCELLABLE", async () => {
      const s = await newStudent();
      const credit = await addBlock(s);
      const id = await insertBooking(s, credit, new Date(Date.now() + 5 * DAY), "cancelled");
      expectError(await call("DELETE", `/schedule/my/${id}`, s), 409, "BOOKING_NOT_CANCELLABLE");
    });

    it("within 24h: 409 CANCEL_CUTOFF", async () => {
      const s = await newStudent();
      const credit = await addBlock(s);
      const id = await insertBooking(s, credit, new Date(Date.now() + 2 * H));
      expectError(await call("DELETE", `/schedule/my/${id}`, s), 409, "CANCEL_CUTOFF");
    });
  });

  describe("PATCH /schedule/my/:id/reschedule", () => {
    it("missing newSlotId: 400 MISSING_FIELDS", async () => {
      const s = await newStudent();
      expectError(await call("PATCH", "/schedule/my/00000000-0000-4000-8000-0000000000dd/reschedule", s, {}), 400, "MISSING_FIELDS");
    });

    it("unknown booking: 404 BOOKING_NOT_FOUND", async () => {
      const s = await newStudent();
      expectError(await call("PATCH", "/schedule/my/00000000-0000-4000-8000-0000000000dd/reschedule", s, { newSlotId: sid(6) }), 404, "BOOKING_NOT_FOUND");
    });

    it("cancelled booking: 409 BOOKING_NOT_RESCHEDULABLE", async () => {
      const s = await newStudent();
      const credit = await addBlock(s);
      const id = await insertBooking(s, credit, new Date(Date.now() + 5 * DAY), "cancelled");
      expectError(await call("PATCH", `/schedule/my/${id}/reschedule`, s, { newSlotId: sid(6) }), 409, "BOOKING_NOT_RESCHEDULABLE");
    });

    it("within 24h: 409 RESCHEDULE_CUTOFF", async () => {
      const s = await newStudent();
      const credit = await addBlock(s);
      const id = await insertBooking(s, credit, new Date(Date.now() + 2 * H));
      expectError(await call("PATCH", `/schedule/my/${id}/reschedule`, s, { newSlotId: sid(6) }), 409, "RESCHEDULE_CUTOFF");
    });

    it("onto a time where the student already has another class: 409 STUDENT_BUSY", async () => {
      const s = await newStudent();
      await addBlock(s);
      const first = await book(s, sid(5));
      const second = await book(s, sid(6));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const other = await newSlot(bogotaYmd(6).dow);
      expectError(await call("PATCH", `/schedule/my/${first.body.data.bookingId}/reschedule`, s, { newSlotId: sid(6, "06", other) }), 409, "STUDENT_BUSY");
    });

    it("onto a blocked slot: 409 SLOT_BLOCKED", async () => {
      const s = await newStudent();
      await addBlock(s);
      const first = await book(s, sid(5));
      await blockAround(7);
      expectError(await call("PATCH", `/schedule/my/${first.body.data.bookingId}/reschedule`, s, { newSlotId: sid(7) }), 409, "SLOT_BLOCKED");
    });

    it("onto a slot taken by someone else: 409 SLOT_TAKEN", async () => {
      const a = await newStudent();
      const b = await newStudent();
      await addBlock(a);
      await addBlock(b);
      const first = await book(a, sid(5));
      expect((await book(b, sid(7))).status).toBe(201);
      expectError(await call("PATCH", `/schedule/my/${first.body.data.bookingId}/reschedule`, a, { newSlotId: sid(7) }), 409, "SLOT_TAKEN");
    });

    it("onto a slot in the past: 409 SLOT_IN_PAST", async () => {
      const s = await newStudent();
      await addBlock(s);
      const first = await book(s, sid(5));
      expectError(await call("PATCH", `/schedule/my/${first.body.data.bookingId}/reschedule`, s, { newSlotId: sid(-3) }), 409, "SLOT_IN_PAST");
    });
  });

  describe("admin booking actions", () => {
    it("reschedule: unknown booking 404 BOOKING_NOT_FOUND", async () => {
      const admin = teacherId;
      expectError(await call("PATCH", "/admin/bookings/00000000-0000-4000-8000-0000000000dd/reschedule", admin, { newSlotId: sid(6) }, "admin"), 404, "BOOKING_NOT_FOUND");
    });

    it("reschedule: cancelled booking 409 BOOKING_NOT_RESCHEDULABLE", async () => {
      const s = await newStudent();
      const credit = await addBlock(s);
      const id = await insertBooking(s, credit, new Date(Date.now() + 5 * DAY), "cancelled");
      expectError(await call("PATCH", `/admin/bookings/${id}/reschedule`, teacherId, { newSlotId: sid(6) }, "admin"), 409, "BOOKING_NOT_RESCHEDULABLE");
    });

    it("reschedule: blocked target 409 SLOT_BLOCKED, taken target 409 SLOT_TAKEN, past target 409 SLOT_IN_PAST", async () => {
      const a = await newStudent();
      const b = await newStudent();
      await addBlock(a);
      await addBlock(b);
      const first = await book(a, sid(5));
      expect((await book(b, sid(7))).status).toBe(201);
      await blockAround(8);
      const url = `/admin/bookings/${first.body.data.bookingId}/reschedule`;
      expectError(await call("PATCH", url, teacherId, { newSlotId: sid(8) }, "admin"), 409, "SLOT_BLOCKED");
      expectError(await call("PATCH", url, teacherId, { newSlotId: sid(7) }, "admin"), 409, "SLOT_TAKEN");
      expectError(await call("PATCH", url, teacherId, { newSlotId: sid(-3) }, "admin"), 409, "SLOT_IN_PAST");
    });

    it("book on behalf: unknown student 404 STUDENT_NOT_FOUND, no credits 409 NO_CREDITS, blocked 409 SLOT_BLOCKED", async () => {
      const s = await newStudent();
      expectError(await call("POST", "/admin/students/00000000-0000-4000-8000-0000000000ee/book", teacherId, { slotId: sid(5) }, "admin"), 404, "STUDENT_NOT_FOUND");
      expectError(await call("POST", `/admin/students/${s}/book`, teacherId, { slotId: sid(5) }, "admin"), 409, "NO_CREDITS");
      await addBlock(s);
      await blockAround(5);
      expectError(await call("POST", `/admin/students/${s}/book`, teacherId, { slotId: sid(5) }, "admin"), 409, "SLOT_BLOCKED");
    });

    it("cancel: already cancelled keeps its coded error", async () => {
      const s = await newStudent();
      const credit = await addBlock(s);
      const id = await insertBooking(s, credit, new Date(Date.now() + 5 * DAY), "cancelled");
      expectError(await call("PATCH", `/admin/bookings/${id}/cancel`, teacherId, {}, "admin"), 400, "ALREADY_CANCELLED");
    });
  });

  describe("portfolio createMentoringRequest (service)", () => {
    const body = (slotId: string) => ({
      slotId, name: "Ana Mentor", email: `${TAG}@mentor.test`, whatsapp: "+573001112233", type: "wordpress" as const, locale: "en" as const,
    });
    const fail = async (slotId: string) => {
      try {
        await createMentoringRequest(fastify, body(slotId));
      } catch (e) {
        return e as AppError;
      }
      throw new Error("expected a failure");
    };

    it("malformed slot id: 400 INVALID_SLOT", async () => {
      const e = await fail("nonsense");
      expect(e).toBeInstanceOf(AppError);
      expect([e.statusCode, e.code]).toEqual([400, "INVALID_SLOT"]);
    });

    it("unknown or inactive slot: 404 SLOT_NOT_FOUND", async () => {
      const { ymd } = bogotaYmd(5);
      const e = await fail(`00000000-0000-4000-8000-0000000000aa_${ymd}_0600`);
      expect([e.statusCode, e.code]).toEqual([404, "SLOT_NOT_FOUND"]);
    });

    it("slot in the past: 409 SLOT_IN_PAST", async () => {
      const e = await fail(sid(-3));
      expect([e.statusCode, e.code]).toEqual([409, "SLOT_IN_PAST"]);
    });

    it("blocked: 409 SLOT_BLOCKED", async () => {
      await blockAround(5);
      const e = await fail(sid(5));
      expect([e.statusCode, e.code]).toEqual([409, "SLOT_BLOCKED"]);
    });

    it("already booked by a class: 409 SLOT_TAKEN", async () => {
      const s = await newStudent();
      await addBlock(s);
      expect((await book(s, sid(5))).status).toBe(201);
      const e = await fail(sid(5));
      expect([e.statusCode, e.code]).toEqual([409, "SLOT_TAKEN"]);
    });
  });
});
