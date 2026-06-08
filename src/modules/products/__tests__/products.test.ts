import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { getApp, closeApp, deleteTestUser } from "../../../test/helpers";
import { eq } from "drizzle-orm";
import { products, accounts } from "../../../db/schema";

const TEST_ADMIN = { email: "admin-products@hub.test", password: "Password123!", displayName: "Admin Products" };

let app: FastifyInstance;
let adminToken: string;

beforeAll(async () => {
  app = await getApp();

  await deleteTestUser(app, TEST_ADMIN.email);

  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    body: TEST_ADMIN,
  });
  const adminId = JSON.parse(Buffer.from(reg.json().data.accessToken.split(".")[1], "base64url").toString()).sub;
  await app.drizzle.update(accounts).set({ role: "admin" }).where(eq(accounts.id, adminId));
  const login = await app.inject({ method: "POST", url: "/auth/login", body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password } });
  adminToken = login.json().data.accessToken;
});

afterAll(async () => {
  await deleteTestUser(app, TEST_ADMIN.email);
  await closeApp();
});

describe("POST /admin/products/sync", () => {
  it("syncs products from Strapi (admin)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/products/sync",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.synced).toBeGreaterThanOrEqual(6);
  });

  it("returns 403 for non-admin", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", body: { email: "user-products@hub.test", password: "Password123!", displayName: "User" } });
    const token = reg.json().data.accessToken;
    const res = await app.inject({
      method: "POST",
      url: "/admin/products/sync",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    await deleteTestUser(app, "user-products@hub.test");
  });
});

describe("GET /products", () => {
  it("returns active products list", async () => {
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(6);
    expect(data[0]).toHaveProperty("slug");
    expect(data[0]).toHaveProperty("priceCop");
    expect(data[0]).toHaveProperty("priceUsd");
    expect(data[0]).not.toHaveProperty("isActive");
  });

  it("returns products ordered by priceCop ascending", async () => {
    const res = await app.inject({ method: "GET", url: "/products" });
    const { data } = res.json();
    for (let i = 1; i < data.length; i++) {
      expect(data[i].priceCop).toBeGreaterThanOrEqual(data[i - 1].priceCop);
    }
  });
});

describe("GET /products/:slug", () => {
  it("returns product by slug", async () => {
    const res = await app.inject({ method: "GET", url: "/products/plan-1-clase" });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.slug).toBe("plan-1-clase");
    expect(data.priceCop).toBe(50000);
    expect(data.priceUsd).toBe(35);
    expect(data.metadata).toMatchObject({ credits: 1 });
  });

  it("returns 404 for unknown slug", async () => {
    const res = await app.inject({ method: "GET", url: "/products/no-existe" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /webhooks/strapi", () => {
  it("upserts product on entry.update event", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/strapi",
      body: {
        event: "entry.update",
        uid: "api::product.product",
        entry: {
          id: 2,
          documentId: "wzieurq2nlcooy7igzwqigt8",
          name: "Plan 1 Clase Updated",
          slug: "plan-1-clase",
          productType: "class_package",
          priceCOP: 55000,
          priceUSD: 38,
          isActive: true,
          metadata: { credits: 1 },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const product = await app.drizzle.query.products.findFirst({
      where: eq(products.slug, "plan-1-clase"),
      columns: { priceCop: true, name: true },
    });
    expect(product?.priceCop).toBe(55000);

    // revert
    await app.inject({
      method: "POST",
      url: "/webhooks/strapi",
      body: {
        event: "entry.update",
        uid: "api::product.product",
        entry: {
          id: 2,
          documentId: "wzieurq2nlcooy7igzwqigt8",
          name: "Plan 1 Clase",
          slug: "plan-1-clase",
          productType: "class_package",
          priceCOP: 50000,
          priceUSD: 35,
          isActive: true,
          metadata: { credits: 1 },
        },
      },
    });
  });

  it("ignores unknown content types", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/strapi",
      body: { event: "entry.create", uid: "api::other.other", entry: {} },
    });
    expect(res.statusCode).toBe(200);
  });
});
