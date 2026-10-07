import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { getApp, closeApp, deleteTestUser } from "../../../test/helpers";
import { accounts, products, paymentMethodSettings } from "../../../db/schema";
import { MemoryCache, CacheTtl, type Cache } from "../../../lib/cache";
import { env } from "../../../config/env";

const TEST_ADMIN = { email: "admin-products-cache@hub.test", password: "Password123!", displayName: "Admin Products Cache" };
const SLUG_A = "cache-test-plan-a";
const SLUG_X = "cache-test-plan-x";
const EXTERNAL_A = "990001";
const EXTERNAL_X = "990002";

let app: FastifyInstance;
let adminToken: string;
let originalCache: Cache;
let cache: MemoryCache;
let clock = 1_000_000;
let productsBefore: Array<{ id: string; isActive: boolean }> = [];
let paymentMethodsBefore: Array<{ method: string; enabled: boolean }> = [];

type FeedItem = { id: number; slug: string; priceUsdCents: number };
const feedOf = (items: FeedItem[]) =>
  JSON.stringify(
    items.map((i) => ({
      id: i.id,
      slug: i.slug,
      status: "publish",
      title: { raw: i.slug },
      nodus_fields: {
        name: i.slug,
        slug: i.slug,
        description: null,
        productType: "class_package",
        priceCOP: 5000,
        priceUSD: i.priceUsdCents / 100, // the feed is in dollars; the DB stores cents
        isActive: true,
        metadata: JSON.stringify({ creditsCount: 1 }),
      },
    })),
  );
const stubWp = (items: FeedItem[]) =>
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(feedOf(items), { status: 200 })));
const feedA = (priceUsdCents: number): FeedItem[] => [{ id: Number(EXTERNAL_A), slug: SLUG_A, priceUsdCents }];

const webhook = () =>
  app.inject({ method: "POST", url: "/webhooks/wp", headers: { "x-webhook-secret": env.wp.webhookSecret }, payload: {} });
const adminSync = () =>
  app.inject({ method: "POST", url: "/admin/products/sync", headers: { authorization: `Bearer ${adminToken}` } });
const getList = () => app.inject({ method: "GET", url: "/products" });
const getBySlug = (slug: string) => app.inject({ method: "GET", url: `/products/${slug}` });
const priceInList = async () =>
  ((await getList()).json().data as Array<{ slug: string; priceUsd: number }>).find((p) => p.slug === SLUG_A)?.priceUsd;

/** Direct DB write that bypasses every service (and therefore every invalidation). */
async function setProductRow(externalId: string, slug: string, priceUsd: number, isActive = true) {
  const values = {
    externalId,
    contentType: "nodus_product",
    slug,
    name: slug,
    priceCop: 5000,
    priceUsd,
    isActive,
    metadata: { creditsCount: 1 },
  };
  await app.drizzle.insert(products).values(values).onConflictDoUpdate({ target: products.externalId, set: values });
}

/** Each test starts from its own explicit baseline: product A active at 1000, product X absent, a fresh cache. */
async function baseline() {
  await app.drizzle.delete(products).where(eq(products.externalId, EXTERNAL_X));
  await setProductRow(EXTERNAL_A, SLUG_A, 1000, true);
  clock = 1_000_000;
  cache = new MemoryCache({ now: () => clock });
  app.cache = cache;
}

beforeAll(async () => {
  app = await getApp();
  originalCache = app.cache;
  productsBefore = await app.drizzle.select({ id: products.id, isActive: products.isActive }).from(products);
  paymentMethodsBefore = await app.drizzle
    .select({ method: paymentMethodSettings.method, enabled: paymentMethodSettings.enabled })
    .from(paymentMethodSettings);
  await deleteTestUser(app, TEST_ADMIN.email);
  const reg = await app.inject({ method: "POST", url: "/auth/register", body: TEST_ADMIN });
  const adminId = JSON.parse(Buffer.from(reg.json().data.accessToken.split(".")[1], "base64url").toString()).sub;
  await app.drizzle.update(accounts).set({ role: "admin" }).where(eq(accounts.id, adminId));
  const login = await app.inject({ method: "POST", url: "/auth/login", body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password } });
  adminToken = login.json().data.accessToken;
});

afterAll(async () => {
  app.cache = originalCache;
  // syncAllProducts deactivates every product missing from the feed: put the shared DB back exactly as found.
  await app.drizzle.delete(products).where(inArray(products.externalId, [EXTERNAL_A, EXTERNAL_X]));
  for (const row of productsBefore) {
    await app.drizzle.update(products).set({ isActive: row.isActive }).where(eq(products.id, row.id));
  }
  for (const row of paymentMethodsBefore) {
    await app.drizzle.update(paymentMethodSettings).set({ enabled: row.enabled }).where(eq(paymentMethodSettings.method, row.method));
  }
  await deleteTestUser(app, TEST_ADMIN.email);
  await closeApp();
});

beforeEach(baseline);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("test environment", () => {
  it("has caching off by default (no-op cache) under NODE_ENV=test", () => {
    expect(originalCache.backend).toBe("none");
  });
});

describe("GET /products cache", () => {
  it("serves the second request from the cache, byte-identical to the miss", async () => {
    const findMany = vi.spyOn(app.drizzle.query.products, "findMany");
    const miss = await getList();
    const hit = await getList();
    expect(miss.statusCode).toBe(200);
    expect(hit.statusCode).toBe(200);
    expect(hit.body).toBe(miss.body);
    expect(hit.headers["content-type"]).toBe(miss.headers["content-type"]);
    expect(hit.headers["content-length"]).toBe(miss.headers["content-length"]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("is invalidated by the WordPress webhook sync", async () => {
    expect(await priceInList()).toBe(1000); // populates the cache
    stubWp(feedA(2000));
    expect((await webhook()).statusCode).toBe(200);
    expect(await priceInList()).toBe(2000);
  });

  it("is invalidated by the admin manual sync", async () => {
    expect(await priceInList()).toBe(1000);
    stubWp(feedA(3000));
    expect((await adminSync()).statusCode).toBe(200);
    expect(await priceInList()).toBe(3000);
  });

  it("a full sync invalidates once, after all writes (not once per product)", async () => {
    const del = vi.spyOn(cache, "delByPrefix");
    stubWp([...feedA(1500), { id: Number(EXTERNAL_X), slug: SLUG_X, priceUsdCents: 1600 }]);
    expect((await webhook()).statusCode).toBe(200);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("still invalidates when the sync fails midway (finally), so a partial write is never served stale", async () => {
    expect(await priceInList()).toBe(1000); // cached
    stubWp(feedA(3000));
    // upserts succeed, the follow-up "deactivate missing products" update blows up
    vi.spyOn(app.drizzle, "update").mockImplementation(() => {
      throw new Error("db went away");
    });
    expect((await webhook()).statusCode).toBe(500);
    vi.restoreAllMocks();
    expect(await priceInList()).toBe(3000);
  });

  it("is only guarded by its TTL if an invalidation is skipped: stale until the TTL, fresh after", async () => {
    expect(await priceInList()).toBe(1000);
    await setProductRow(EXTERNAL_A, SLUG_A, 7000); // direct write, no invalidation
    expect(await priceInList()).toBe(1000);
    clock += (CacheTtl.products - 1) * 1000;
    expect(await priceInList()).toBe(1000);
    clock += 2000;
    expect(await priceInList()).toBe(7000);
  });

  it("still answers from the DB when the cache itself fails, and a failing invalidation does not fail the sync", async () => {
    const boom = async () => {
      throw new Error("redis down");
    };
    app.cache = { backend: "redis", get: boom, set: boom, del: boom, delByPrefix: boom };
    expect(await priceInList()).toBe(1000);
    stubWp(feedA(3500));
    expect((await webhook()).statusCode).toBe(200);
    expect(await priceInList()).toBe(3500);
  });
});

describe("GET /products/:slug cache", () => {
  it("caches a found product (identical body) and drops it on sync", async () => {
    const findFirst = vi.spyOn(app.drizzle.query.products, "findFirst");
    const miss = await getBySlug(SLUG_A);
    const hit = await getBySlug(SLUG_A);
    expect(miss.statusCode).toBe(200);
    expect(hit.body).toBe(miss.body);
    expect(hit.headers["content-length"]).toBe(miss.headers["content-length"]);
    expect(findFirst).toHaveBeenCalledTimes(1);

    stubWp(feedA(4000));
    await webhook();
    expect((await getBySlug(SLUG_A)).json().data.priceUsd).toBe(4000);
  });

  it("does not cache 404s, so unknown slugs cannot grow the cache", async () => {
    const findFirst = vi.spyOn(app.drizzle.query.products, "findFirst");
    for (let i = 0; i < 3; i++) expect((await getBySlug("does-not-exist")).statusCode).toBe(404);
    expect(findFirst).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
  });

  it("does not cache an existing but INACTIVE product", async () => {
    await setProductRow(EXTERNAL_A, SLUG_A, 1000, false);
    const findFirst = vi.spyOn(app.drizzle.query.products, "findFirst");
    for (let i = 0; i < 3; i++) expect((await getBySlug(SLUG_A)).statusCode).toBe(404);
    expect(findFirst).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
  });

  it("a sync that deactivates a product invalidates its cached detail page", async () => {
    await setProductRow(EXTERNAL_X, SLUG_X, 1200, true);
    expect((await getBySlug(SLUG_X)).statusCode).toBe(200); // cached
    stubWp(feedA(1000)); // X is no longer in the feed -> deactivated
    expect((await webhook()).statusCode).toBe(200);
    expect((await getBySlug(SLUG_X)).statusCode).toBe(404);
  });
});

describe("GET /payment-methods cache", () => {
  it("is cached (identical body), and invalidated when an admin toggles a method", async () => {
    const findMany = vi.spyOn(app.drizzle.query.paymentMethodSettings, "findMany");
    const get = () => app.inject({ method: "GET", url: "/payment-methods" });

    const miss = await get();
    const hit = await get();
    expect(hit.body).toBe(miss.body);
    expect(hit.headers["content-length"]).toBe(miss.headers["content-length"]);
    expect(findMany).toHaveBeenCalledTimes(1);

    const before = miss.json().data;
    const flipped = !before.paypal;
    try {
      const patch = await app.inject({
        method: "PATCH",
        url: "/admin/payment-methods/paypal",
        headers: { authorization: `Bearer ${adminToken}` },
        body: { enabled: flipped },
      });
      expect(patch.statusCode).toBe(200);
      expect((await get()).json().data.paypal).toBe(flipped);
    } finally {
      await app.drizzle
        .update(paymentMethodSettings)
        .set({ enabled: before.paypal })
        .where(eq(paymentMethodSettings.method, "paypal"));
    }
  });

  it("falls through to the DB when the cache fails", async () => {
    const boom = async () => {
      throw new Error("redis down");
    };
    app.cache = { backend: "redis", get: boom, set: boom, del: boom, delByPrefix: boom };
    const res = await app.inject({ method: "GET", url: "/payment-methods" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data).sort()).toEqual(["epayco", "manual_transfer", "paypal"]);
  });

  it("is only guarded by its TTL if an invalidation is skipped", async () => {
    const get = async () => (await app.inject({ method: "GET", url: "/payment-methods" })).json().data.paypal as boolean;
    const original = await get();
    try {
      await app.drizzle.update(paymentMethodSettings).set({ enabled: !original }).where(eq(paymentMethodSettings.method, "paypal"));
      expect(await get()).toBe(original); // stale: nothing invalidated
      clock += (CacheTtl.paymentMethods + 1) * 1000;
      expect(await get()).toBe(!original);
    } finally {
      await app.drizzle.update(paymentMethodSettings).set({ enabled: original }).where(eq(paymentMethodSettings.method, "paypal"));
    }
  });
});
