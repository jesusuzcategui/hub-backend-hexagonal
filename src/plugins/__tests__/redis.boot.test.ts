import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Any attempt to construct a real ioredis client is recorded (and yields an inert object).
const ioredisCtor = vi.hoisted(() => vi.fn());
vi.mock("ioredis", () => ({ default: ioredisCtor }));

const SAVED = { REDIS_URL: process.env.REDIS_URL, CACHE_ENABLED: process.env.CACHE_ENABLED };

function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function bootApp(redisUrl: string): Promise<FastifyInstance> {
  // config/env parses process.env once, at import: reset the module graph so this boot sees our value.
  vi.resetModules();
  process.env.REDIS_URL = redisUrl;
  delete process.env.CACHE_ENABLED;
  const { buildApp } = await import("../../app");
  const app = buildApp();
  await app.ready();
  return app;
}

describe("full app boot with no REDIS_URL", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ioredisCtor.mockClear();
    app = await bootApp("");
  });
  afterAll(async () => {
    await app?.close();
    restoreEnv();
  });

  it("starts and /health reports Redis as disabled", async () => {
    expect(app.redis).toBeNull();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", redis: "disabled" });
    expect(ioredisCtor).not.toHaveBeenCalled();
  });

  it("rate limiting works on the in-memory store: 3 requests pass, the 4th is limited (the limited call is 429)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: "POST", url: "/contact", remoteAddress: "10.9.9.9", payload: {} });
      codes.push(res.statusCode);
    }
    // The first three reach validation (400 for the empty body); the 4th is rejected by the rate limiter.
    expect(codes).toEqual([400, 400, 400, 429]);
  });
});

describe("tests never open a real Redis connection, even if REDIS_URL is set in the environment", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ioredisCtor.mockClear();
    expect(process.env.NODE_ENV).toBe("test");
    app = await bootApp("redis://127.0.0.1:6390");
  });
  afterAll(async () => {
    await app?.close();
    restoreEnv();
  });

  it("a plain buildApp() with REDIS_URL set constructs no client", async () => {
    expect(ioredisCtor).not.toHaveBeenCalled();
    expect(app.redis).toBeNull();
    expect(app.rateLimitStore).toBeUndefined();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "ok", redis: "disabled", cache: "off" });
  });
});
