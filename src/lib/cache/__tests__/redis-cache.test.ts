import { describe, it, expect, vi, afterEach } from "vitest";
import { RedisCache } from "../redis-cache";
import { RedisGuard } from "../guard";
import { MemoryCache } from "../memory";
import { cached } from "../cached";
import { FakeRedis } from "./fake-redis";

function setup(opts: { timeoutMs?: number; cooldownMs?: number; versionTtlMs?: number; retryMs?: number } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const log = { info: vi.fn(), warn: vi.fn() };
  const redis = new FakeRedis(now);
  const guard = new RedisGuard({ timeoutMs: opts.timeoutMs ?? 30, cooldownMs: opts.cooldownMs ?? 1000, now, log });
  const make = (client = redis, namespace = "hub-a") =>
    new RedisCache(client, {
      namespace,
      guard,
      fallback: new MemoryCache({ now }),
      versionTtlMs: opts.versionTtlMs,
      retryMs: opts.retryMs,
      now,
    });
  return { redis, guard, cache: make(), make, log, advance: (ms: number) => (t += ms) };
}

afterEach(() => vi.useRealTimers());

describe("RedisCache keys and TTL", () => {
  it("stores under <ns>:c:<group>:v<ver>:<rest>", async () => {
    const { cache, redis } = setup();
    await cache.set("products:list", [{ id: 1 }], 60);
    await cache.set("payment-methods", { a: 1 }, 60);
    expect([...redis.store.keys()].sort()).toEqual(["hub-a:c:payment-methods:v0:", "hub-a:c:products:v0:list"]);
    expect(await cache.get("products:list")).toEqual([{ id: 1 }]);
    expect(await cache.get("payment-methods")).toEqual({ a: 1 });
    expect(cache.backend).toBe("redis");
  });

  it("expires entries after the TTL in SECONDS (EX), not before and not never", async () => {
    const { cache, advance } = setup();
    await cache.set("products:list", "v", 10);
    advance(9_999);
    expect(await cache.get("products:list")).toBe("v");
    advance(2);
    expect(await cache.get("products:list")).toBeNull();
  });

  it("two deployments sharing one Redis do not see or invalidate each other's entries", async () => {
    const { redis, make } = setup();
    const a = make(redis, "hub-a");
    const b = make(redis, "hub-b");
    await a.set("products:list", "A", 60);
    await b.set("products:list", "B", 60);
    expect(await a.get("products:list")).toBe("A");
    expect(await b.get("products:list")).toBe("B");
    await a.delByPrefix("products:");
    expect(await a.get("products:list")).toBeNull();
    expect(await b.get("products:list")).toBe("B");
  });

  it("treats a corrupt stored value as a miss", async () => {
    const { cache, redis } = setup();
    redis.store.set("hub-a:c:k:v0:", { value: "{not json", expiresAt: null });
    expect(await cache.get("k")).toBeNull();
  });
});

describe("RedisCache version-based invalidation (no SCAN)", () => {
  it("delByPrefix is one INCR of the group's version: the group is gone, others untouched", async () => {
    const { cache, redis } = setup();
    await cache.set("products:list", 1, 60);
    await cache.set("products:slug:x", 2, 60);
    await cache.set("payment-methods", 3, 60);
    const incr = vi.spyOn(redis, "incr");
    await cache.delByPrefix("products:");
    expect(incr).toHaveBeenCalledTimes(1);
    expect(incr).toHaveBeenCalledWith("hub-a:c:ver:products");
    expect(await cache.get("products:list")).toBeNull();
    expect(await cache.get("products:slug:x")).toBeNull();
    expect(await cache.get("payment-methods")).toBe(3);
    // old-version keys are not deleted, they just become unreachable and expire by TTL
    expect(redis.store.has("hub-a:c:products:v0:list")).toBe(true);
  });

  it("del(key) invalidates the key's group", async () => {
    const { cache } = setup();
    await cache.set("payment-methods", 1, 60);
    await cache.del("payment-methods");
    expect(await cache.get("payment-methods")).toBeNull();
  });

  it("a bump on the same instance takes effect immediately (no version-cache delay)", async () => {
    const { cache } = setup({ versionTtlMs: 60_000 });
    await cache.set("products:list", "old", 60);
    await cache.delByPrefix("products:");
    await cache.set("products:list", "new", 60);
    expect(await cache.get("products:list")).toBe("new");
  });

  it("another instance sees the bump within the version cache window", async () => {
    const { redis, make, advance } = setup({ versionTtlMs: 1000 });
    const a = make(redis);
    const b = make(redis);
    await a.set("products:list", "old", 60);
    expect(await b.get("products:list")).toBe("old"); // b caches version 0
    await a.delByPrefix("products:");
    expect(await b.get("products:list")).toBe("old"); // still within b's window: bounded staleness
    advance(1001);
    expect(await b.get("products:list")).toBeNull();
  });

  it("reads the version once per window, not on every get", async () => {
    const { cache, redis } = setup({ versionTtlMs: 1000 });
    await cache.set("products:list", 1, 60);
    const get = vi.spyOn(redis, "get");
    for (let i = 0; i < 5; i++) await cache.get("products:list");
    expect(get).toHaveBeenCalledTimes(5); // 5 data reads, 0 version reads
  });

  it("empty prefix bumps every group this instance has seen", async () => {
    const { cache } = setup();
    await cache.set("products:list", 1, 60);
    await cache.set("payment-methods", 2, 60);
    await cache.delByPrefix("");
    expect(await cache.get("products:list")).toBeNull();
    expect(await cache.get("payment-methods")).toBeNull();
  });
});

describe("RedisCache graceful degradation", () => {
  it("a throwing Redis never throws to the caller and falls back to memory", async () => {
    const { cache, redis, guard, log } = setup();
    redis.mode = "throw";
    await expect(cache.set("k", 1, 60)).resolves.toBeUndefined();
    expect(await cache.get("k")).toBe(1); // served by the in-memory fallback
    await expect(cache.del("k")).resolves.toBeUndefined();
    await expect(cache.delByPrefix("k")).resolves.toBeUndefined();
    expect(guard.isDegraded).toBe(true);
    expect(cache.backend).toBe("memory");
    expect(log.warn).toHaveBeenCalledTimes(1); // one line per outage, not per request
  });

  it("a hanging Redis is cut off by the guard timeout (fake timers)", async () => {
    vi.useFakeTimers();
    const { cache, redis } = setup({ timeoutMs: 25 });
    redis.mode = "hang";
    const p = cache.get("k");
    await vi.advanceTimersByTimeAsync(26);
    expect(await p).toBeNull();
  });

  it("the breaker stops hitting Redis during the cooldown, then probes again", async () => {
    const { cache, redis, advance } = setup({ cooldownMs: 1000 });
    redis.mode = "throw";
    await cache.get("k");
    const callsAfterFailure = redis.calls;
    for (let i = 0; i < 20; i++) await cache.get("k");
    expect(redis.calls).toBe(callsAfterFailure);

    redis.mode = "ok";
    advance(1001);
    await cache.set("k", "v", 60);
    expect(redis.calls).toBeGreaterThan(callsAfterFailure);
    expect(await cache.get("k")).toBe("v");
    expect(cache.backend).toBe("redis");
  });

  it("logs recovery once Redis answers again", async () => {
    const { cache, redis, advance, log } = setup({ cooldownMs: 10 });
    redis.mode = "throw";
    await cache.get("k");
    redis.mode = "ok";
    advance(11);
    await cache.get("k");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("recovered"));
  });

  it("a bump missed during an outage is replayed before the next Redis read: no stale resurrection", async () => {
    const { cache, redis, advance } = setup({ cooldownMs: 10, versionTtlMs: 60_000 });
    await cache.set("products:list", "stale", 300);
    redis.mode = "throw";
    await cache.delByPrefix("products:"); // could not reach Redis, queued
    redis.mode = "ok";
    advance(11);
    expect(await cache.get("products:list")).toBeNull(); // would be "stale" without the replay
  });

  it("a failed replay MERGES with bumps queued meanwhile instead of overwriting them", async () => {
    const { cache, redis, advance } = setup({ cooldownMs: 10, versionTtlMs: 60_000 });
    await cache.set("a:1", "x", 300);
    await cache.set("b:1", "y", 300);
    redis.mode = "throw";
    await cache.delByPrefix("a:");
    advance(11);
    await cache.get("a:1"); // replay attempt fails, "a" must stay queued
    await cache.delByPrefix("b:"); // queued during the outage
    redis.mode = "ok";
    advance(11);
    expect(await cache.get("a:1")).toBeNull();
    expect(await cache.get("b:1")).toBeNull();
  });

  it("concurrent readers share ONE in-flight replay and none reads before it finished", async () => {
    const { cache, redis, advance } = setup({ cooldownMs: 10, versionTtlMs: 60_000 });
    await cache.set("products:list", "stale", 300);
    redis.mode = "throw";
    await cache.delByPrefix("products:");
    redis.mode = "ok";
    advance(11);
    const incr = vi.spyOn(redis, "incr");
    const results = await Promise.all(Array.from({ length: 6 }, () => cache.get("products:list")));
    expect(results).toEqual([null, null, null, null, null, null]);
    expect(incr).toHaveBeenCalledTimes(1);
  });

  it("retries queued bumps in the background, without waiting for a read", async () => {
    vi.useFakeTimers();
    const { cache, redis, advance } = setup({ cooldownMs: 10, retryMs: 500 });
    redis.mode = "throw";
    await cache.delByPrefix("products:");
    redis.mode = "ok";
    advance(11);
    await vi.advanceTimersByTimeAsync(501);
    expect(redis.store.get("hub-a:c:ver:products")?.value).toBe("1");
  });

  it("the read-through helper falls through to the loader when the cache fails", async () => {
    const { cache, redis } = setup();
    redis.mode = "throw";
    const load = vi.fn(async () => ["db row"]);
    expect(await cached(cache, "k", 60, load)).toEqual(["db row"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cached() survives a cache whose methods throw outright", async () => {
    const broken = {
      backend: "redis" as const,
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
      del: async () => {},
      delByPrefix: async () => {},
    };
    expect(await cached(broken, "k", 60, async () => 42)).toBe(42);
  });
});
