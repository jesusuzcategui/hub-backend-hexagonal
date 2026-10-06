import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getApp, closeApp, deleteTestUser } from "../../../test/helpers";
import { accounts, products, classCredits, weeklySlots, bookings } from "../../../db/schema";

const TEST_ADMIN = { email: "admin-weekly-slots@hub.test", password: "Password123!", displayName: "Admin Weekly Slots" };
const TEST_STUDENT = { email: "student-weekly-slots@hub.test", password: "Password123!", displayName: "Student Weekly Slots" };

let app: FastifyInstance;
let adminToken: string;
let adminId: string;
let studentId: string;
let productId: string;

async function createWeeklySlotRow() {
  const [slot] = await app.drizzle
    .insert(weeklySlots)
    .values({ teacherId: adminId, dayOfWeek: 1, startTime: "17:00", endTime: "19:30", isActive: true })
    .returning({ id: weeklySlots.id });
  return slot.id;
}

async function createUpcomingBooking(weeklySlotId: string) {
  const [credit] = await app.drizzle
    .insert(classCredits)
    .values({ userId: studentId, productId, totalCredits: 1, usedCredits: 0 })
    .returning({ id: classCredits.id });

  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 2.5 * 60 * 60 * 1000);

  const [booking] = await app.drizzle
    .insert(bookings)
    .values({
      studentId,
      creditId: credit.id,
      weeklySlotId,
      productId,
      status: "confirmed",
      startsAt,
      endsAt,
    })
    .returning({ id: bookings.id });

  return booking.id;
}

beforeAll(async () => {
  app = await getApp();

  await deleteTestUser(app, TEST_ADMIN.email);
  await deleteTestUser(app, TEST_STUDENT.email);

  const adminReg = await app.inject({ method: "POST", url: "/auth/register", body: TEST_ADMIN });
  adminId = JSON.parse(Buffer.from(adminReg.json().data.accessToken.split(".")[1], "base64url").toString()).sub;
  await app.drizzle.update(accounts).set({ role: "admin" }).where(eq(accounts.id, adminId));
  const login = await app.inject({ method: "POST", url: "/auth/login", body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password } });
  adminToken = login.json().data.accessToken;

  const studentReg = await app.inject({ method: "POST", url: "/auth/register", body: TEST_STUDENT });
  studentId = JSON.parse(Buffer.from(studentReg.json().data.accessToken.split(".")[1], "base64url").toString()).sub;

  const [product] = await app.drizzle
    .insert(products)
    .values({
      externalId: `test-weekly-slots-${Date.now()}`,
      contentType: "nodus_product",
      slug: `test-weekly-slots-${Date.now()}`,
      name: "Test Weekly Slots Product",
      priceCop: 100000,
      priceUsd: 25,
      isActive: true,
    })
    .returning({ id: products.id });
  productId = product.id;
});

afterAll(async () => {
  await deleteTestUser(app, TEST_ADMIN.email);
  await deleteTestUser(app, TEST_STUDENT.email);
  await app.drizzle.delete(products).where(eq(products.id, productId));
  await closeApp();
});

describe("PATCH /admin/weekly-slots/:id", () => {
  it("deactivates a slot, blocks new bookings, and notifies students with upcoming bookings", async () => {
    const slotId = await createWeeklySlotRow();
    await createUpcomingBooking(slotId);

    const sendMailSpy = vi.spyOn(app.mailer, "sendMail").mockResolvedValue({} as never);

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/weekly-slots/${slotId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { isActive: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.slot.isActive).toBe(false);
    expect(res.json().data.notifiedBookings).toBe(1);
    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    expect(sendMailSpy.mock.calls[0][0]).toMatchObject({ to: TEST_STUDENT.email });

    const slotsRes = await app.inject({
      method: "GET",
      url: "/admin/slots",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const bookableIds = (slotsRes.json().data as Array<{ id: string }>).map((s) => s.id);
    expect(bookableIds.some((id) => id.startsWith(slotId))).toBe(false);

    sendMailSpy.mockRestore();
  });

  it("is idempotent when deactivating an already-inactive slot", async () => {
    const slotId = await createWeeklySlotRow();
    await app.drizzle.update(weeklySlots).set({ isActive: false }).where(eq(weeklySlots.id, slotId));

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/weekly-slots/${slotId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { isActive: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.slot.isActive).toBe(false);
    expect(res.json().data.notifiedBookings).toBe(0);
  });

  it("still succeeds and does not fail the request if the notification email fails to send", async () => {
    const slotId = await createWeeklySlotRow();
    await createUpcomingBooking(slotId);

    const sendMailSpy = vi.spyOn(app.mailer, "sendMail").mockRejectedValue(new Error("SMTP down"));

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/weekly-slots/${slotId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { isActive: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.slot.isActive).toBe(false);
    expect(res.json().data.notifiedBookings).toBe(0);

    sendMailSpy.mockRestore();
  });

  it("reactivates a slot without sending notifications", async () => {
    const slotId = await createWeeklySlotRow();
    await app.drizzle.update(weeklySlots).set({ isActive: false }).where(eq(weeklySlots.id, slotId));

    const sendMailSpy = vi.spyOn(app.mailer, "sendMail").mockResolvedValue({} as never);

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/weekly-slots/${slotId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: { isActive: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.isActive).toBe(true);
    expect(sendMailSpy).not.toHaveBeenCalled();

    sendMailSpy.mockRestore();
  });

  it("returns 404 for a non-existent slot", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/weekly-slots/00000000-0000-4000-a000-000000000000",
      headers: { authorization: `Bearer ${adminToken}` },
      body: { isActive: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when isActive is missing", async () => {
    const slotId = await createWeeklySlotRow();
    const res = await app.inject({
      method: "PATCH",
      url: `/admin/weekly-slots/${slotId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      body: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for non-admin", async () => {
    const slotId = await createWeeklySlotRow();
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      body: { email: "user-weekly-slots@hub.test", password: "Password123!", displayName: "User" },
    });
    const token = reg.json().data.accessToken;
    const res = await app.inject({
      method: "PATCH",
      url: `/admin/weekly-slots/${slotId}`,
      headers: { authorization: `Bearer ${token}` },
      body: { isActive: false },
    });
    expect(res.statusCode).toBe(403);
    await deleteTestUser(app, "user-weekly-slots@hub.test");
  });
});
