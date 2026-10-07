import { describe, it, expect, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import redisPlugin from "../redis";
import { rateLimitStoreOptions } from "../../lib/cache";

// Uses the REAL ioredis against a port nothing listens on (nothing is mocked, no Redis needed): proves that an
// unreachable Redis at boot never blocks or breaks the app. The explicit `url` is the only way tests connect.
describe("real ioredis against an unreachable Redis", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("boots, reports degraded, serves requests and closes cleanly", async () => {
    app = Fastify();
    await app.register(redisPlugin, { url: "redis://127.0.0.1:1", cacheEnabled: true, bootWaitMs: 150 });
    await app.register(rateLimit, { ...rateLimitStoreOptions(app, "t"), max: 2, timeWindow: "1 minute" });
    app.get("/ping", async () => ({ ok: true }));
    app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok", ...app.cacheInfo() }));

    await expect(app.ready()).resolves.toBeDefined();
    expect(app.redis).not.toBeNull();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", redis: "degraded", cache: "memory" });

    // cache and rate limiting keep working in-process
    await app.cache.set("k", { v: 1 }, 60);
    expect(await app.cache.get("k")).toEqual({ v: 1 });
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push((await app.inject({ method: "GET", url: "/ping" })).statusCode);
    expect(hits.slice(0, 2)).toEqual([200, 200]);
    expect(hits[2]).toBe(429);

    await expect(app.close()).resolves.toBeUndefined();
  });
});
