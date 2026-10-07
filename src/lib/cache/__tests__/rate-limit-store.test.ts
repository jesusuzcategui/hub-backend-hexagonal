import { describe, it, expect } from "vitest";
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

  it("a hanging Redis does not block requests", async () => {
    const redis = new FakeRedis();
    redis.mode = "hang";
    const app = await buildApp({ redis });
    const started = Date.now();
    expect(await hit(app)).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
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
