import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createRateLimitStore } from "../rate-limit-store";
import { RedisGuard } from "../guard";
import { FakeRedis } from "./fake-redis";

async function buildApp(opts: { redis: FakeRedis | null; namespace?: string; max?: number; scope?: string }) {
  const guard = new RedisGuard({ timeoutMs: 30, cooldownMs: 60_000 });
  const store = createRateLimitStore({ client: opts.redis, guard, namespace: opts.namespace ?? "hub-a", scope: opts.scope });
  const app = Fastify();
  await app.register(rateLimit, {
    store,
    max: opts.max ?? 2,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({ statusCode: 429, error: { code: "RATE_LIMITED", message: "Too many requests." } }),
  });
  app.get("/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

afterEach(() => vi.useRealTimers());

const hit = (app: Awaited<ReturnType<typeof buildApp>>) =>
  app.inject({ method: "GET", url: "/ping", remoteAddress: "10.0.0.1" }).then((r) => r.statusCode);

describe("rate limit store", () => {
  it("enforces the same limit with Redis as without (429 on the third hit, max 2)", async () => {
    const app = await buildApp({ redis: new FakeRedis() });
    expect([await hit(app), await hit(app), await hit(app)]).toEqual([200, 200, 429]);
    await app.close();
  });

  it("counters are shared between two instances using the same Redis", async () => {
    const redis = new FakeRedis();
    const a = await buildApp({ redis });
    const b = await buildApp({ redis });
    expect([await hit(a), await hit(b), await hit(a), await hit(b)]).toEqual([200, 200, 429, 429]);
    await a.close();
    await b.close();
  });

  it("different deployments sharing one Redis do not share counters", async () => {
    const redis = new FakeRedis();
    const a = await buildApp({ redis, namespace: "hub-a" });
    const b = await buildApp({ redis, namespace: "hub-b" });
    await hit(a);
    await hit(a);
    expect(await hit(a)).toBe(429);
    expect(await hit(b)).toBe(200);
    await a.close();
    await b.close();
  });

  it("without Redis it counts in memory with identical behavior", async () => {
    const app = await buildApp({ redis: null });
    expect([await hit(app), await hit(app), await hit(app)]).toEqual([200, 200, 429]);
    await app.close();
  });

  it("a throwing Redis degrades to the in-memory counter: never a 500, limit still enforced", async () => {
    const redis = new FakeRedis();
    redis.mode = "throw";
    const app = await buildApp({ redis });
    expect([await hit(app), await hit(app), await hit(app)]).toEqual([200, 200, 429]);
    await app.close();
  });

  it("a hanging Redis does not block requests: the guard timeout lets the in-memory counter answer", async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    redis.mode = "hang";
    const app = await buildApp({ redis });
    const p = hit(app);
    await vi.advanceTimersByTimeAsync(31); // guard timeout is 30 ms in this suite
    expect(await p).toBe(200);
    await app.close();
  });

  it("registrations with different scopes keep separate counters for the same IP", async () => {
    const redis = new FakeRedis();
    const login = await buildApp({ redis, scope: "auth" });
    const contact = await buildApp({ redis, scope: "contact" });
    await hit(contact);
    await hit(contact);
    expect(await hit(contact)).toBe(429);
    expect(await hit(login)).toBe(200); // contact traffic must not burn the login budget
    expect([...redis.store.keys()].some((k) => k.startsWith("hub-a:rl:auth:"))).toBe(true);
    await login.close();
    await contact.close();
  });
});

type StoreInstance = {
  incr(key: string, cb: (e: Error | null, r?: { current: number; ttl: number }) => void, tw: number): void;
  read(key: string, cb: (e: Error | null, r?: { current: number; ttl: number }) => void, tw: number): void;
  localIncr(key: string, tw: number): { current: number; ttl: number };
};
const incr = (st: StoreInstance, key: string, tw: number) =>
  new Promise<{ current: number; ttl: number }>((res, rej) => st.incr(key, (e, r) => (e ? rej(e) : res(r!)), tw));
const read = (st: StoreInstance, key: string, tw: number) =>
  new Promise<{ current: number; ttl: number }>((res, rej) => st.read(key, (e, r) => (e ? rej(e) : res(r!)), tw));

function localStore(extra: { maxLocalKeys?: number; log?: { warn: (m: string) => void }; redis?: FakeRedis } = {}) {
  let t = 5_000;
  const guard = new RedisGuard({ timeoutMs: 30, cooldownMs: 60_000, now: () => t });
  const Store = createRateLimitStore({
    client: extra.redis ?? null,
    guard: extra.redis ? guard : null,
    namespace: "hub-a",
    scope: "auth",
    now: () => t,
    maxLocalKeys: extra.maxLocalKeys,
    log: extra.log,
  }) as unknown as new () => StoreInstance;
  return { store: new Store(), advance: (ms: number) => (t += ms) };
}

describe("in-memory counter (direct)", () => {
  it("counts within a window and reports the remaining ttl", () => {
    const { store, advance } = localStore();
    expect(store.localIncr("ip", 1000)).toEqual({ current: 1, ttl: 1000 });
    advance(400);
    expect(store.localIncr("ip", 1000)).toEqual({ current: 2, ttl: 600 });
  });

  it("starts a fresh window once the previous one elapsed (window reset)", () => {
    const { store, advance } = localStore();
    store.localIncr("ip", 1000);
    store.localIncr("ip", 1000);
    advance(1000);
    expect(store.localIncr("ip", 1000)).toEqual({ current: 1, ttl: 1000 });
  });

  it("read() peeks without incrementing and reports a clean state after expiry", async () => {
    const { store, advance } = localStore();
    await incr(store, "ip", 1000);
    expect(await read(store, "ip", 1000)).toMatchObject({ current: 1 });
    expect(await read(store, "ip", 1000)).toMatchObject({ current: 1 });
    advance(1000);
    expect(await read(store, "ip", 1000)).toEqual({ current: 0, ttl: 0 });
  });

  it("is bounded: evicts expired then oldest keys past maxLocalKeys", () => {
    const { store, advance } = localStore({ maxLocalKeys: 3 });
    store.localIncr("a", 1000);
    advance(10);
    store.localIncr("b", 1000);
    store.localIncr("c", 1000);
    store.localIncr("d", 1000); // full: oldest ("a") goes
    expect(store.localIncr("a", 1000).current).toBe(1); // a was evicted, so it starts over
    for (let i = 0; i < 50; i++) store.localIncr(`k${i}`, 1000);
    expect(store.localIncr("k49", 1000).current).toBe(2); // newest survive
  });
});

describe("degraded warning", () => {
  it("warns once per 30 s while counting per process, and again after that", async () => {
    const warn = vi.fn();
    const redis = new FakeRedis();
    redis.mode = "throw";
    const { store, advance } = localStore({ redis, log: { warn } });
    for (let i = 0; i < 10; i++) await incr(store, "ip", 1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("rate-limit[auth]");
    expect(warn.mock.calls[0][0]).toContain("per process");
    advance(30_001);
    await incr(store, "ip", 1000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("scopes of the real route registrations", () => {
  const root = join(__dirname, "..", "..", "..", "modules");
  const scopeOf = (mod: string) => {
    const src = readFileSync(join(root, mod, `${mod}.routes.ts`), "utf8");
    const m = [...src.matchAll(/rateLimitStoreOptions\(\w+,\s*"([^"]+)"\)/g)];
    expect(m.length).toBe(1);
    return m[0][1];
  };

  it("auth, cart, contact and portfolio each get a distinct scope", () => {
    const scopes = ["auth", "cart", "contact", "portfolio"].map(scopeOf);
    expect(new Set(scopes).size).toBe(4);
  });
});
