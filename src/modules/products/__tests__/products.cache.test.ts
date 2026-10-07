import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getApp, closeApp, deleteTestUser } from "../../../test/helpers";
import { accounts, products } from "../../../db/schema";
import { MemoryCache, type Cache } from "../../../lib/cache";
import { env } from "../../../config/env";

const TEST_ADMIN = { email: "admin-products-cache@hub.test", password: "Password123!", displayName: "Admin Products Cache" };
const SLUG = "cache-test-plan";

let app: FastifyInstance;
let adminToken: string;
let originalCache: Cache;
let cache: MemoryCache;
let priceUsd = 1000;

function wpFeed() {
  return JSON.stringify([
    {
      id: 9901,
      slug: SLUG,
      status: "publish",
      title: { raw: SLUG },
      nodus_fields: {
        name: SLUG,
        slug: SLUG,
        description: null,
        productType: "class_package",
        priceCOP: 5000,
        priceUSD: priceUsd / 100,
        isActive: true,
        metadata: JSON.stringify({ creditsCount: 1 }),
      },
    },
  ]);
}

function stubWp() {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(wpFeed(), { status: 200 })));
}

const webhook = () =>
  app.inject({ method: "POST", url: "/webhooks/wp", headers: { "x-webhook-secret": env.wp.webhookSecret }, payload: {} });
const adminSync = () =>
  app.inject({ method: "POST", url: "/admin/products/sync", headers: { authorization: `Bearer ${adminToken}` } });
const listPriceOfTestProduct = async () => {
  const res = await app.inject({ method: "GET", url: "/products" });
  expect(res.statusCode).toBe(200);
  return (res.json().data as Array<{ slug: string; priceUsd: number }>).find((p) => p.slug === SLUG)?.priceUsd;
};

beforeAll(async () => {
  app = await getApp();
  originalCache = app.cache;
  await deleteTestUser(app, TEST_ADMIN.email);
  const reg = await app.inject({ method: "POST", url: "/auth/register", body: TEST_ADMIN });
  const adminId = JSON.parse(Buffer.from(reg.json().data.accessToken.split(".")[1], "base64url").toString()).sub;
  await app.drizzle.update(accounts).set({ role: "admin" }).where(eq(accounts.id, adminId));
  const login = await app.inject({ method: "POST", url: "/auth/login", body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password } });
  adminToken = login.json().data.accessToken;
  stubWp();
  priceUsd = 1000;
  await adminSync();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  app.cache = originalCache;
  await app.drizzle.delete(products).where(eq(products.slug, SLUG));
  await deleteTestUser(app, TEST_ADMIN.email);
  await closeApp();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Caching is off under NODE_ENV=test; this suite switches it on explicitly by installing a cache.
function enableCache() {
  cache = new MemoryCache();
  app.cache = cache;
}

describe("test environment", () => {
  it("has caching off by default (no-op cache) under NODE_ENV=test", () => {
    expect(originalCache.backend).toBe("none");
  });
});

describe("GET /products cache", () => {
  it("serves the second request from the cache (miss, then hit)", async () => {
    enableCache();
    const findMany = vi.spyOn(app.drizzle.query.products, "findMany");
    const a = await app.inject({ method: "GET", url: "/products" });
    const b = await app.inject({ method: "GET", url: "/products" });
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("is invalidated by the WordPress webhook sync", async () => {
    enableCache();
    expect(await listPriceOfTestProduct()).toBe(1000); // populates the cache
    priceUsd = 2000;
    stubWp();
    expect((await webhook()).statusCode).toBe(200);
    expect(await listPriceOfTestProduct()).toBe(2000);
  });

  it("is invalidated by the admin manual sync", async () => {
    enableCache();
    expect(await listPriceOfTestProduct()).toBe(2000);
    priceUsd = 3000;
    stubWp();
    expect((await adminSync()).statusCode).toBe(200);
    expect(await listPriceOfTestProduct()).toBe(3000);
  });

  it("still answers from the DB when the cache itself fails", async () => {
    app.cache = {
      backend: "redis",
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
      del: async () => {
        throw new Error("redis down");
      },
      delByPrefix: async () => {
        throw new Error("redis down");
      },
    };
    expect(await listPriceOfTestProduct()).toBe(3000);
    priceUsd = 3500;
    stubWp();
    expect((await webhook()).statusCode).toBe(200); // a failing invalidation must not fail the sync
    expect(await listPriceOfTestProduct()).toBe(3500);
  });
});

describe("GET /products/:slug cache", () => {
  it("caches a found product and drops it on sync", async () => {
    enableCache();
    const findFirst = vi.spyOn(app.drizzle.query.products, "findFirst");
    const get = () => app.inject({ method: "GET", url: `/products/${SLUG}` });
    const a = await get();
    const b = await get();
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(findFirst).toHaveBeenCalledTimes(1);

    priceUsd = 4000;
    stubWp();
    await webhook();
    expect((await get()).json().data.priceUsd).toBe(4000);
  });

  it("does not cache 404s, so unknown slugs cannot grow the cache", async () => {
    enableCache();
    const findFirst = vi.spyOn(app.drizzle.query.products, "findFirst");
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/products/does-not-exist" });
      expect(res.statusCode).toBe(404);
    }
    expect(findFirst).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
  });
});

describe("GET /payment-methods cache", () => {
  it("is cached, and invalidated when an admin toggles a method", async () => {
    enableCache();
    const findMany = vi.spyOn(app.drizzle.query.paymentMethodSettings, "findMany");
    const get = () => app.inject({ method: "GET", url: "/payment-methods" });

    const before = (await get()).json().data;
    await get();
    expect(findMany).toHaveBeenCalledTimes(1);

    const flipped = !before.paypal;
    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/payment-methods/paypal",
      headers: { authorization: `Bearer ${adminToken}` },
      body: { enabled: flipped },
    });
    expect(patch.statusCode).toBe(200);
    expect((await get()).json().data.paypal).toBe(flipped);

    // restore the original value
    await app.inject({
      method: "PATCH",
      url: "/admin/payment-methods/paypal",
      headers: { authorization: `Bearer ${adminToken}` },
      body: { enabled: before.paypal },
    });
    expect((await get()).json().data.paypal).toBe(before.paypal);
  });
});
