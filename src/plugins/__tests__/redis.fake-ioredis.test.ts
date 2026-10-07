import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Replace ioredis with an in-memory client so the REAL plugin path (connect options, ready event, rate-limit
// store wiring, real routes) runs with Redis "enabled" and no network.
const fakeState = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("ioredis", async () => {
  const { FakeRedis } = await import("../../lib/cache/__tests__/fake-redis");
  class FakeIoredis extends FakeRedis {
    status = "ready";
    constructor(public url?: string, public opts?: unknown) {
      super();
      fakeState.instances.push(this);
    }
    on() {
      return this;
    }
    off() {
      return this;
    }
    async quit() {
      return "OK";
    }
    disconnect() {}
  }
  return { default: FakeIoredis };
});

const SAVED = { ...process.env };
let app: FastifyInstance;

beforeAll(async () => {
  vi.resetModules();
  // NODE_ENV=test would (deliberately) ignore REDIS_URL, so present this boot as a non-test one.
  process.env.NODE_ENV = "development";
  process.env.REDIS_URL = "redis://fake:6379";
  delete process.env.CACHE_ENABLED;
  process.env.REMINDERS_ENABLED = "false";
  process.env.PAYMENT_AUTOVERIFY_ENABLED = "false";
  process.env.CALDAV_SYNC_ENABLED = "false";
  const { buildApp } = await import("../../app");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

describe("app with Redis enabled (fake ioredis)", () => {
  it("connects with fail-fast options and reports redis + cache active", async () => {
    expect(fakeState.instances).toHaveLength(1);
    expect(fakeState.instances[0].opts).toMatchObject({
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ status: "ok", redis: "connected", cache: "redis" });
  });

  it("real routes use the shared store: same limit and same rate-limited status as without Redis", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: "POST", url: "/contact", remoteAddress: "10.8.8.8", payload: {} });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([400, 400, 400, 500]); // identical to the in-memory path (see redis.boot.test.ts)
    const keys = [...fakeState.instances[0].store.keys()] as string[];
    expect(keys.some((k) => k.includes(":rl:contact:") && k.endsWith("10.8.8.8"))).toBe(true);
  });

  it("an outage degrades health and keeps requests working", async () => {
    fakeState.instances[0].mode = "throw";
    const codes: number[] = [];
    for (let i = 0; i < 2; i++) {
      codes.push((await app.inject({ method: "POST", url: "/contact", remoteAddress: "10.7.7.7", payload: {} })).statusCode);
    }
    expect(codes).toEqual([400, 400]);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", redis: "degraded" });
    fakeState.instances[0].mode = "ok";
  });
});
