import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import Redis from "ioredis";
import { RedisCache } from "../redis-cache";
import { RedisGuard } from "../guard";
import { createRateLimitStore } from "../rate-limit-store";

// OPT-IN: runs only when REDIS_TEST_URL points at a THROWAWAY Redis (never a shared/dev one):
//   REDIS_TEST_URL=redis://127.0.0.1:6391 pnpm vitest run src/lib/cache/__tests__/redis.real.test.ts
// All keys live under a unique namespace and are removed individually afterwards (no FLUSH).
const URL = process.env.REDIS_TEST_URL;

describe.skipIf(!URL)("against a real Redis", () => {
  const ns = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  let client: Redis;

  beforeAll(() => {
    client = new Redis(URL!);
  });
  afterAll(async () => {
    const keys = await client.keys(`${ns}*`);
    if (keys.length) await client.del(...keys);
    await client.quit();
  });

  async function limiterApp(scope: string, max = 2) {
    const guard = new RedisGuard({ timeoutMs: 1000 });
    const store = createRateLimitStore({ client, guard, namespace: ns, scope });
    const app = Fastify();
    await app.register(rateLimit, {
      store,
      max,
      timeWindow: "1 minute",
      errorResponseBuilder: () => ({ statusCode: 429, error: "limited" }),
    });
    app.get("/p", async () => ({ ok: true }));
    await app.ready();
    return app;
  }
  const hit = (app: Awaited<ReturnType<typeof limiterApp>>) =>
    app.inject({ method: "GET", url: "/p", remoteAddress: "7.7.7.7" }).then((r) => r.statusCode);

  it("INCR script: 200, 200, 429 with the window passed in milliseconds", async () => {
    const app = await limiterApp("lua");
    expect([await hit(app), await hit(app), await hit(app)]).toEqual([200, 200, 429]);
    const key = (await client.keys(`${ns}:rl:lua:*`))[0];
    const pttl = await client.pttl(key);
    expect(pttl).toBeGreaterThan(50_000); // ARGV is ms: a seconds/ms mixup would give ~60 or 60_000_000
    expect(pttl).toBeLessThanOrEqual(60_000);
    await app.close();
  });

  it("INCR script repairs a counter that lost its TTL, so a limit can never become permanent", async () => {
    const app = await limiterApp("repair");
    await client.set(`${ns}:rl:repair:7.7.7.7`, "1"); // no expiry
    expect(await client.pttl(`${ns}:rl:repair:7.7.7.7`)).toBe(-1);
    await hit(app);
    const pttl = await client.pttl(`${ns}:rl:repair:7.7.7.7`);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);
    await app.close();
  });

  it("cache entries get an EX TTL in seconds", async () => {
    const cache = new RedisCache(client, { namespace: ns, guard: new RedisGuard({ timeoutMs: 1000 }) });
    await cache.set("products:list", [1, 2], 100);
    const key = (await client.keys(`${ns}:c:products:v*:list`))[0];
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it("version invalidation works across two instances sharing one Redis", async () => {
    const guard = new RedisGuard({ timeoutMs: 1000 });
    const a = new RedisCache(client, { namespace: ns, guard, versionTtlMs: 0 });
    const b = new RedisCache(client, { namespace: ns, guard, versionTtlMs: 0 });
    await a.set("products:list", "old", 60);
    expect(await b.get("products:list")).toBe("old");
    await a.delByPrefix("products:");
    expect(await b.get("products:list")).toBeNull();
    await b.set("products:list", "new", 60);
    expect(await a.get("products:list")).toBe("new");
  });
});
