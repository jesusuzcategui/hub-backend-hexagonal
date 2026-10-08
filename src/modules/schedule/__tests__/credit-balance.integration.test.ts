// DB-backed tests for the single credit balance. They NEVER touch DATABASE_URL:
// they only run when CREDITS_IT_DATABASE_URL points at a throwaway database.
//   CREDITS_IT_DATABASE_URL=postgres://postgres:x@localhost:5433/hub_it pnpm exec vitest run credit-balance.integration
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { eq, inArray } from "drizzle-orm";
import { createDrizzle } from "../../../db";
import { accounts } from "../../../db/schema/users";
import { products } from "../../../db/schema/ecommerce";
import { availabilities, bookings, classCredits } from "../../../db/schema/scheduling";
import { AppError } from "../../../lib/errors";
import {
  createStudentBooking,
  cancelStudentBooking,
  rescheduleStudentBooking,
} from "../schedule.service";
import { scheduleRoutes } from "../schedule.routes";
import { adminRoutes } from "../../admin/admin.routes";
import { cancelBooking, grantCreditsToStudent, listStudentActiveCredits } from "../../admin/admin.service";

const DB_URL = process.env.CREDITS_IT_DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;
const TAG = `cbit_${Date.now()}`;

describe.skipIf(!DB_URL)("credit balance (throwaway DB)", () => {
  let pool: Pool;
  let db: ReturnType<typeof createDrizzle>;
  let fastify: FastifyInstance;
  let teacherId: string;
  let adminId: string;
  const accountIds: string[] = [];
  const productIds: string[] = [];
  const availIds: string[] = [];
  let seq = 0;

  async function newStudent() {
    const [a] = await db
      .insert(accounts)
      .values({ email: `${TAG}_s${seq++}@hub.test`, displayName: "IT Student", role: "user" })
      .returning({ id: accounts.id });
    accountIds.push(a.id);
    return a.id;
  }

  async function newProduct(metadata: Record<string, unknown>) {
    const n = seq++;
    const [p] = await db
      .insert(products)
      .values({ externalId: `${TAG}_${n}`, contentType: "nodus_product", slug: `${TAG}-${n}`, name: `IT Plan ${n}`, metadata })
      .returning({ id: products.id });
    productIds.push(p.id);
    return p.id;
  }

  async function newBlock(userId: string, productId: string, over: Partial<typeof classCredits.$inferInsert> = {}) {
    const [c] = await db
      .insert(classCredits)
      .values({ userId, productId, totalCredits: 4, usedCredits: 0, ...over })
      .returning({ id: classCredits.id });
    return c.id;
  }

  async function newSlot(daysAhead = 10) {
    const startsAt = new Date(Date.now() + daysAhead * DAY + seq++ * 3_600_000);
    const [s] = await db
      .insert(availabilities)
      .values({ teacherId, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) })
      .returning({ id: availabilities.id });
    availIds.push(s.id);
    return s.id;
  }

  const block = async (id: string) =>
    (await db.select().from(classCredits).where(eq(classCredits.id, id)))[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    db = createDrizzle(pool);
    fastify = Fastify();
    fastify.decorate("drizzle", db);
    fastify.decorate("caldav", { createEvent: vi.fn(), deleteEvent: vi.fn() });
    fastify.decorate("mailer", { sendMail: vi.fn().mockResolvedValue({}) } as any);
    fastify.decorate("authenticate", async (req: any) => {
      req.user = { sub: req.headers["x-user"], role: req.headers["x-role"] ?? "user" };
    });
    fastify.setErrorHandler((error: any, _req, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.status(500).send({ error: error.message });
    });
    await fastify.register(scheduleRoutes);
    await fastify.register(adminRoutes);
    await fastify.ready();

    const [t] = await db.insert(accounts).values({ email: `${TAG}_teacher@hub.test`, displayName: "T", role: "user" }).returning({ id: accounts.id });
    const [ad] = await db.insert(accounts).values({ email: `${TAG}_admin@hub.test`, displayName: "A", role: "admin" }).returning({ id: accounts.id });
    teacherId = t.id;
    adminId = ad.id;
    accountIds.push(t.id, ad.id);
  });

  afterAll(async () => {
    if (!pool) return;
    await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
    await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    if (availIds.length) await db.delete(availabilities).where(inArray(availabilities.id, availIds));
    if (productIds.length) await db.delete(products).where(inArray(products.id, productIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
    await fastify.close();
    await pool.end();
  });

  describe("grants set an expiry", () => {
    it("defaults to 60 days when the product has no validityDays", async () => {
      const student = await newStudent();
      const productId = await newProduct({ creditsCount: 4 });
      const before = Date.now();
      await grantCreditsToStudent(fastify, student, { productId, totalCredits: 4, paymentMethod: "cash", grantedBy: adminId });
      const [row] = await db.select().from(classCredits).where(eq(classCredits.userId, student));
      expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 60 * DAY);
      expect(row.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60 * DAY);
    });

    it("uses the product validityDays (settlement path goes through the same function)", async () => {
      const student = await newStudent();
      const productId = await newProduct({ creditsCount: 12, validityDays: 90 });
      const before = Date.now();
      await grantCreditsToStudent(fastify, student, { productId, totalCredits: 12, paymentMethod: "online", grantedBy: student, notes: "Auto-granted on settlement" });
      const [row] = await db.select().from(classCredits).where(eq(classCredits.userId, student));
      expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 90 * DAY);
      expect(row.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 90 * DAY);
    });

    it("lets an explicit admin expiresAt win", async () => {
      const student = await newStudent();
      const productId = await newProduct({ validityDays: 90 });
      await grantCreditsToStudent(fastify, student, { productId, totalCredits: 2, paymentMethod: "cash", grantedBy: adminId, expiresAt: "2030-01-01T00:00:00.000Z" });
      const [row] = await db.select().from(classCredits).where(eq(classCredits.userId, student));
      expect(row.expiresAt!.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    });

    it("rejects an unparseable explicit expiresAt", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      await expect(
        grantCreditsToStudent(fastify, student, { productId, totalCredits: 2, paymentMethod: "cash", grantedBy: adminId, expiresAt: "not-a-date" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe("booking", () => {
    it("auto-picks the block that expires first, then moves on", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const later = await newBlock(student, productId, { totalCredits: 4, expiresAt: new Date(Date.now() + 30 * DAY) });
      const sooner = await newBlock(student, productId, { totalCredits: 2, expiresAt: new Date(Date.now() + 15 * DAY) });

      await createStudentBooking(fastify, { studentId: student, slotId: await newSlot() });
      await createStudentBooking(fastify, { studentId: student, slotId: await newSlot() });
      expect((await block(sooner)).usedCredits).toBe(2);
      expect((await block(later)).usedCredits).toBe(0);

      await createStudentBooking(fastify, { studentId: student, slotId: await newSlot() });
      expect((await block(later)).usedCredits).toBe(1);
    });

    it("auto-picks a never-expiring block last", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const never = await newBlock(student, productId, { expiresAt: null });
      const dated = await newBlock(student, productId, { expiresAt: new Date(Date.now() + 40 * DAY) });
      await createStudentBooking(fastify, { studentId: student, slotId: await newSlot() });
      expect((await block(dated)).usedCredits).toBe(1);
      expect((await block(never)).usedCredits).toBe(0);
    });

    it("cannot book when every block is expired", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const expired = await newBlock(student, productId, { expiresAt: new Date(Date.now() - DAY) });
      await expect(createStudentBooking(fastify, { studentId: student, slotId: await newSlot() })).rejects.toMatchObject({
        statusCode: 409,
        code: "CREDITS_EXPIRED",
      });
      expect((await block(expired)).usedCredits).toBe(0);
    });

    it("cannot book when there are no credits at all", async () => {
      const student = await newStudent();
      await expect(createStudentBooking(fastify, { studentId: student, slotId: await newSlot() })).rejects.toMatchObject({
        statusCode: 409,
        message: "No credits remaining",
      });
    });

    it("still accepts an explicit creditId, but rejects it when that block is expired", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const ok = await newBlock(student, productId, { expiresAt: new Date(Date.now() + 30 * DAY) });
      const expired = await newBlock(student, productId, { expiresAt: new Date(Date.now() - 1000) });

      await createStudentBooking(fastify, { studentId: student, slotId: await newSlot(), creditId: ok });
      expect((await block(ok)).usedCredits).toBe(1);

      await expect(
        createStudentBooking(fastify, { studentId: student, slotId: await newSlot(), creditId: expired }),
      ).rejects.toMatchObject({ statusCode: 409, code: "CREDIT_EXPIRED" });
    });

    it("does not let a student use someone else's block", async () => {
      const owner = await newStudent();
      const thief = await newStudent();
      const productId = await newProduct({});
      const theirs = await newBlock(owner, productId);
      await expect(
        createStudentBooking(fastify, { studentId: thief, slotId: await newSlot(), creditId: theirs }),
      ).rejects.toThrow("Credit not found");
    });
  });

  describe("refunds and honored bookings", () => {
    it("cancel returns the credit to the block it came from and keeps its expiry", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const expiresAt = new Date(Date.now() + 15 * DAY);
      const sooner = await newBlock(student, productId, { totalCredits: 2, expiresAt });
      const later = await newBlock(student, productId, { totalCredits: 4, expiresAt: new Date(Date.now() + 30 * DAY) });

      const { bookingId } = await createStudentBooking(fastify, { studentId: student, slotId: await newSlot() });
      expect((await block(sooner)).usedCredits).toBe(1);

      await cancelStudentBooking(fastify, bookingId, student);

      const after = await block(sooner);
      expect(after.usedCredits).toBe(0);
      expect(after.expiresAt!.getTime()).toBe(expiresAt.getTime());
      expect((await block(later)).usedCredits).toBe(0);
    });

    it("an admin cancel also refunds the original block, even if it expired in the meantime (not usable afterwards)", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const id = await newBlock(student, productId, { totalCredits: 2, expiresAt: new Date(Date.now() + 15 * DAY) });
      const { bookingId } = await createStudentBooking(fastify, { studentId: student, slotId: await newSlot() });

      const expired = new Date(Date.now() - DAY);
      await db.update(classCredits).set({ expiresAt: expired }).where(eq(classCredits.id, id));

      await cancelBooking(fastify, bookingId, "test");

      const after = await block(id);
      expect(after.usedCredits).toBe(0);
      expect(after.expiresAt!.getTime()).toBe(expired.getTime());
      await expect(createStudentBooking(fastify, { studentId: student, slotId: await newSlot() })).rejects.toMatchObject({ code: "CREDITS_EXPIRED" });
    });

    it("a credit that expired in the meantime cannot carry a booking to a later date; the original booking stays", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const id = await newBlock(student, productId, { totalCredits: 2, expiresAt: new Date(Date.now() + 15 * DAY) });
      const { bookingId } = await createStudentBooking(fastify, { studentId: student, slotId: await newSlot() });
      await db.update(classCredits).set({ expiresAt: new Date(Date.now() - DAY) }).where(eq(classCredits.id, id));

      await expect(
        rescheduleStudentBooking(fastify, { bookingId, studentId: student, newSlotId: await newSlot(12) }),
      ).rejects.toMatchObject({ statusCode: 409, code: "CLASS_AFTER_CREDIT_EXPIRY" });

      const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(row.status).toBe("confirmed");
      expect((await block(id)).usedCredits).toBe(1);
    });
  });

  describe("API shape", () => {
    it("GET /schedule/credits keeps `data` and adds balance, nextExpiry and blocks", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const soon = new Date(Date.now() + 5 * DAY);
      await newBlock(student, productId, { totalCredits: 8, usedCredits: 3, expiresAt: new Date(Date.now() + 30 * DAY) });
      await newBlock(student, productId, { totalCredits: 4, usedCredits: 1, expiresAt: soon });
      await newBlock(student, productId, { totalCredits: 4, expiresAt: new Date(Date.now() - DAY) });

      const res = await fastify.inject({ method: "GET", url: "/schedule/credits", headers: { "x-user": student } });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.balance).toBe(8);
      expect(body.nextExpiry).toBe(soon.toISOString());
      expect(body.blocks).toHaveLength(2);
      expect(body.data).toEqual(body.blocks);
      expect(body.data[0]).toEqual({
        creditId: expect.any(String),
        productId,
        productName: expect.any(String),
        totalCredits: 4,
        usedCredits: 1,
        remaining: 3,
        expiresAt: soon.toISOString(),
      });
    });

    it("GET /admin/students/:id/active-credits returns the same summary", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      const soon = new Date(Date.now() + 5 * DAY);
      await newBlock(student, productId, { totalCredits: 4, usedCredits: 1, expiresAt: soon });

      const res = await fastify.inject({
        method: "GET",
        url: `/admin/students/${student}/active-credits`,
        headers: { "x-user": adminId, "x-role": "admin" },
      });
      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.balance).toBe(3);
      expect(body.nextExpiry).toBe(soon.toISOString());
      expect(body.data).toEqual(body.blocks);
      expect(body.blocks[0]).toMatchObject({ totalCredits: 4, usedCredits: 1, remaining: 3, expiresAt: soon.toISOString() });
      expect((await listStudentActiveCredits(fastify, student)).balance).toBe(3);
    });

    it("POST /schedule/book works without creditId", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      await newBlock(student, productId, { expiresAt: new Date(Date.now() + 15 * DAY) });
      const res = await fastify.inject({
        method: "POST",
        url: "/schedule/book",
        headers: { "x-user": student },
        payload: { slotId: await newSlot() },
      });
      expect(res.statusCode).toBe(201);
    });

    it("POST /schedule/book answers 409 when every block is expired", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      await newBlock(student, productId, { expiresAt: new Date(Date.now() - DAY) });
      const res = await fastify.inject({
        method: "POST",
        url: "/schedule/book",
        headers: { "x-user": student },
        payload: { slotId: await newSlot() },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: "CREDITS_EXPIRED", message: expect.stringMatching(/expired/i) });
    });

    it("POST /admin/students/:id/book works without creditId", async () => {
      const student = await newStudent();
      const productId = await newProduct({});
      await newBlock(student, productId, { expiresAt: new Date(Date.now() + 15 * DAY) });
      const res = await fastify.inject({
        method: "POST",
        url: `/admin/students/${student}/book`,
        headers: { "x-user": adminId, "x-role": "admin" },
        payload: { slotId: await newSlot() },
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
