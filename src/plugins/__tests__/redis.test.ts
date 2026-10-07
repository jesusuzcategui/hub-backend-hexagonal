import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../../config/env", () => ({
  env: { cache: { url: undefined, prefix: "hub-test" } },
}));

import redisPlugin, { type RedisPluginOptions } from "../redis";
import { FakeRedis } from "../../lib/cache/__tests__/fake-redis";
import { getCache, rateLimitStoreOptions } from "../../lib/cache";

async function boot(opts?: RedisPluginOptions) {
  const app = Fastify();
  await app.register(redisPlugin, opts ?? {});
  app.get("/health", async () => ({ status: "ok", ...app.cacheInfo() }));
  await app.ready();
  return app;
}

describe("redis plugin without REDIS_URL", () => {
  it("boots, decorates redis as null and reports it as disabled", async () => {
    const app = await boot();
    expect(app.redis).toBeNull();
    expect(app.rateLimitStore).toBeUndefined();
    expect(rateLimitStoreOptions(app, "x")).toEqual({});
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", redis: "disabled", cache: "off" });
    await app.close();
  });

  it("caching is a pass-through under NODE_ENV=test", async () => {
    const app = await boot();
    expect(app.cache.backend).toBe("none");
    await app.cache.set("k", 1, 60);
    expect(await app.cache.get("k")).toBeNull();
    await app.close();
  });

  it("uses the bounded in-memory cache when caching is explicitly enabled", async () => {
    const app = await boot({ cacheEnabled: true });
    expect(app.cache.backend).toBe("memory");
    await app.cache.set("k", { a: 1 }, 60);
    expect(await app.cache.get("k")).toEqual({ a: 1 });
    expect(app.cacheInfo()).toEqual({ redis: "disabled", cache: "memory" });
    await app.close();
  });
});

describe("redis plugin with an injected client", () => {
  it("shares cache and rate-limit store through Redis and reports connected", async () => {
    const redis = new FakeRedis();
    const app = await boot({ client: redis, cacheEnabled: true });
    expect(app.cacheInfo()).toEqual({ redis: "connected", cache: "redis" });
    expect(app.rateLimitStore).toBeDefined();
    expect(rateLimitStoreOptions(app, "x").store).toBeDefined();
    await app.cache.set("products:list", [1], 60);
    expect([...redis.store.keys()]).toEqual(["hub-test:c:products:list"]);
    await app.close();
  });

  it("an outage flips health to degraded without failing the app, and requests keep working", async () => {
    const redis = new FakeRedis();
    const app = await boot({ client: redis, cacheEnabled: true });
    redis.mode = "throw";
    await app.cache.set("k", "v", 60);
    expect(await app.cache.get("k")).toBe("v");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", redis: "degraded", cache: "memory" });
    await app.close();
  });

  it("getCache falls back to a pass-through when the plugin is not registered", () => {
    expect(getCache(Fastify()).backend).toBe("none");
  });
});
