import { describe, it, expect, vi } from "vitest";
import { RedisCache } from "../redis-cache";
import { RedisGuard } from "../guard";
import { MemoryCache } from "../memory";
import { cached } from "../cached";
import { FakeRedis } from "./fake-redis";

function setup(opts: { timeoutMs?: number; cooldownMs?: number } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const log = { info: vi.fn(), warn: vi.fn() };
  const redis = new FakeRedis(now);
  const guard = new RedisGuard({ timeoutMs: opts.timeoutMs ?? 30, cooldownMs: opts.cooldownMs ?? 1000, now, log });
  const cache = new RedisCache(redis, { namespace: "hub-a", guard, fallback: new MemoryCache({ now }) });
  return { redis, guard, cache, log, advance: (ms: number) => (t += ms) };
}

describe("RedisCache (fake client)", () => {
  it("stores under the deployment namespace and reads back", async () => {
    const { cache, redis } = setup();
    await cache.set("products:list", [{ id: 1 }], 60);
    expect([...redis.store.keys()]).toEqual(["hub-a:c:products:list"]);
    expect(await cache.get("products:list")).toEqual([{ id: 1 }]);
    expect(cache.backend).toBe("redis");
  });

  it("two deployments sharing one Redis do not see or delete each other's keys", async () => {
    const { redis, guard } = setup();
    const a = new RedisCache(redis, { namespace: "hub-a", guard });
    const b = new RedisCache(redis, { namespace: "hub-b", guard });
    await a.set("products:list", "A", 60);
    await b.set("products:list", "B", 60);
    expect(await a.get("products:list")).toBe("A");
    expect(await b.get("products:list")).toBe("B");
    await a.delByPrefix("products:");
    expect(await a.get("products:list")).toBeNull();
    expect(await b.get("products:list")).toBe("B");
  });

  it("delByPrefix removes only matching keys and escapes glob characters", async () => {
    const { cache, redis } = setup();
    await cache.set("products:list", 1, 60);
    await cache.set("products:slug:x", 2, 60);
    await cache.set("payment-methods", 3, 60);
    await cache.set("a*b", 4, 60);
    await cache.set("axb", 5, 60);
    await cache.delByPrefix("products:");
    expect(await cache.get("products:list")).toBeNull();
    expect(await cache.get("payment-methods")).toBe(3);
    await cache.delByPrefix("a*");
    expect(await cache.get("a*b")).toBeNull();
    expect(redis.store.has("hub-a:c:axb")).toBe(true);
  });

  it("treats a corrupt stored value as a miss", async () => {
    const { cache, redis } = setup();
    redis.store.set("hub-a:c:k", { value: "{not json", expiresAt: null });
    expect(await cache.get("k")).toBeNull();
  });

  describe("graceful degradation", () => {
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

    it("a hanging Redis is cut off by the timeout instead of blocking the request", async () => {
      const { cache, redis } = setup({ timeoutMs: 25 });
      redis.mode = "hang";
      const started = Date.now();
      expect(await cache.get("k")).toBeNull();
      expect(Date.now() - started).toBeLessThan(500);
    });

    it("the circuit breaker stops hitting Redis during the cooldown, then probes again", async () => {
      const { cache, redis, advance } = setup({ cooldownMs: 1000 });
      redis.mode = "throw";
      await cache.get("k");
      const callsAfterFailure = redis.calls;
      for (let i = 0; i < 20; i++) await cache.get("k");
      expect(redis.calls).toBe(callsAfterFailure); // no further attempts while open

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

    it("replays invalidations missed during an outage before serving the next Redis read", async () => {
      const { cache, redis, advance } = setup({ cooldownMs: 10 });
      await cache.set("products:list", "stale", 300);

      redis.mode = "throw";
      await cache.delByPrefix("products:"); // could not reach Redis

      redis.mode = "ok";
      advance(11);
      // Without the replay this would return "stale", written before the outage.
      expect(await cache.get("products:list")).toBeNull();
    });

    it("keeps unreplayed invalidations if Redis is still down, and applies them later", async () => {
      const { cache, redis, advance } = setup({ cooldownMs: 10 });
      await cache.set("payment-methods", "stale", 300);
      redis.mode = "throw";
      await cache.del("payment-methods");
      advance(11);
      await cache.get("payment-methods"); // probe fails again, pending kept
      redis.mode = "ok";
      advance(11);
      expect(await cache.get("payment-methods")).toBeNull();
    });

    it("an invalidation that fails while a replay is running is not lost", async () => {
      const { cache, redis, advance } = setup({ cooldownMs: 10 });
      await cache.set("a:1", "x", 300);
      await cache.set("b:1", "y", 300);
      redis.mode = "throw";
      await cache.delByPrefix("a:");
      redis.mode = "ok";
      advance(11);
      // replay of "a:" starts; meanwhile another invalidation is queued by a failure
      redis.mode = "throw";
      await cache.get("a:1"); // replay fails, "a:" must be kept
      await cache.delByPrefix("b:"); // queued during the outage
      redis.mode = "ok";
      advance(11);
      expect(await cache.get("a:1")).toBeNull();
      expect(await cache.get("b:1")).toBeNull();
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
});
