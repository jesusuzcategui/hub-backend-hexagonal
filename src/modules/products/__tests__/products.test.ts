import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
  it("syncs products from WordPress (admin)", async () => {
    // WordPress is never called for real: fetch is stubbed with a canned feed.
    const wpItem = (id: number, slug: string, usd: number, credits: number) => ({
      id,
      slug,
      status: "publish",
      title: { raw: slug },
      nodus_fields: {
        name: slug,
        slug,
        description: null,
        productType: "class_package",
        priceCOP: 1000 * id,
        priceUSD: usd,
        isActive: true,
        metadata: JSON.stringify({ creditsCount: credits }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([wpItem(75, "single-session", 15, 1), wpItem(76, "basic", 57.5, 4)]),
          { status: 200 },
        ),
      ),
    );
    const res = await app.inject({
      method: "POST",
      url: "/admin/products/sync",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    vi.unstubAllGlobals();
    expect(res.json().data.synced).toBe(2);
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
    expect(data.priceUsd).toBe(3500); // stored in cents
    expect(data.metadata).toMatchObject({ credits: 1 });
  });

  it("returns 404 for unknown slug", async () => {
    const res = await app.inject({ method: "GET", url: "/products/no-existe" });
    expect(res.statusCode).toBe(404);
  });
});
