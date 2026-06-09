import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { getApp, closeApp, deleteTestUser } from "../../../test/helpers";
import { eq } from "drizzle-orm";
import { orders, accounts, classCredits, orderItems, payments } from "../../../db/schema";

// Mock payment providers — avoid real API calls in tests
vi.mock("../providers/mercadopago", () => ({
  createMpPreference: vi.fn().mockResolvedValue({
    preferenceId: "MP_PREF_TEST_123",
    initPoint: "https://www.mercadopago.com.co/checkout/v1/redirect?pref_id=MP_PREF_TEST_123",
  }),
}));

vi.mock("../providers/paypal", () => ({
  createPaypalOrder: vi.fn().mockResolvedValue({
    ppOrderId: "PP_ORDER_TEST_456",
    approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PP_ORDER_TEST_456",
  }),
  capturePaypalOrder: vi.fn().mockResolvedValue("COMPLETED"),
}));

const TEST_USER = { email: "checkout-user@hub.test", password: "Password123!", displayName: "Checkout User" };

let app: FastifyInstance;
let userToken: string;
let userId: string;
let copProductId: string;
let usdProductId: string;

beforeAll(async () => {
  app = await getApp();
  await deleteTestUser(app, TEST_USER.email);

  const reg = await app.inject({ method: "POST", url: "/auth/register", body: TEST_USER });
  userToken = reg.json().data.accessToken;
  userId = JSON.parse(Buffer.from(userToken.split(".")[1], "base64url").toString()).sub;

  // Sync products first
  await app.inject({
    method: "POST",
    url: "/admin/products/sync",
    headers: { authorization: `Bearer ${userToken}` },
  });

  // Get a product ID from DB
  const productList = await app.inject({ method: "GET", url: "/products" });
  const prods = productList.json().data;
  copProductId = prods[0].id;
  usdProductId = prods[0].id;
});

afterAll(async () => {
  // Clean up in FK-safe order
  const account = await app.drizzle.query.accounts.findFirst({
    where: eq(accounts.email, TEST_USER.email.toLowerCase()),
    columns: { id: true },
  });
  if (account) {
    const userOrders = await app.drizzle.query.orders.findMany({
      where: eq(orders.userId, account.id),
      columns: { id: true },
    });
    for (const o of userOrders) {
      await app.drizzle.delete(classCredits).where(eq(classCredits.orderId, o.id));
      await app.drizzle.delete(payments).where(eq(payments.orderId, o.id));
      await app.drizzle.delete(orderItems).where(eq(orderItems.orderId, o.id));
    }
    await app.drizzle.delete(orders).where(eq(orders.userId, account.id));
  }
  await deleteTestUser(app, TEST_USER.email);
  await closeApp();
});

describe("POST /checkout", () => {
  it("returns 401 without token", async () => {
    const res = await app.inject({ method: "POST", url: "/checkout", body: { productId: copProductId, currency: "COP" } });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown product", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { authorization: `Bearer ${userToken}` },
      body: { productId: "00000000-0000-0000-0000-000000000000", currency: "COP" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("creates COP order and returns MP init_point", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { authorization: `Bearer ${userToken}` },
      body: { productId: copProductId, currency: "COP" },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.gateway).toBe("mercadopago");
    expect(data.paymentUrl).toContain("mercadopago.com");
    expect(data.orderId).toBeDefined();
  });

  it("creates USD order and returns PayPal approval URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { authorization: `Bearer ${userToken}` },
      body: { productId: usdProductId, currency: "USD" },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.gateway).toBe("paypal");
    expect(data.paymentUrl).toContain("paypal.com");
  });

  it("returns 400 with invalid currency", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { authorization: `Bearer ${userToken}` },
      body: { productId: copProductId, currency: "EUR" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /checkout/orders", () => {
  it("returns user orders list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/checkout/orders",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/checkout/orders" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /webhooks/mercadopago", () => {
  it("ignores non-payment events", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/mercadopago",
      body: { action: "subscription.preapproval", data: { id: "123" } },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /webhooks/paypal — grant credits on PAYMENT.CAPTURE.COMPLETED", () => {
  it("grants class credits when payment captured", async () => {
    // Create a pending COP order to simulate payment
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { authorization: `Bearer ${userToken}` },
      body: { productId: copProductId, currency: "COP" },
    });
    const orderId = checkoutRes.json().data.orderId;

    // Simulate PayPal webhook
    const webhookRes = await app.inject({
      method: "POST",
      url: "/webhooks/paypal",
      body: {
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          id: "PP_CAP_789",
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: orderId,
              amount: { value: "35.00", currency_code: "USD" },
            },
          ],
        },
      },
    });
    expect(webhookRes.statusCode).toBe(200);

    // Order should be paid
    const order = await app.drizzle.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { status: true },
    });
    expect(order?.status).toBe("paid");

    // Credits should be granted
    const credits = await app.drizzle.query.classCredits.findFirst({
      where: eq(classCredits.orderId, orderId),
      columns: { totalCredits: true },
    });
    expect(credits?.totalCredits).toBeGreaterThan(0);
  });
});
