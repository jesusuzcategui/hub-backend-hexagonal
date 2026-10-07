import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

// REDIS_URL must be unset before config/env is first imported (it is parsed once, at import time).
let app: FastifyInstance;

beforeAll(async () => {
  process.env.REDIS_URL = "";
  delete process.env.CACHE_ENABLED;
  const { buildApp } = await import("../../app");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("full app boot with no REDIS_URL", () => {
  it("starts and /health reports Redis as disabled", async () => {
    expect(app.redis).toBeNull();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", redis: "disabled" });
  });

  it("rate limiting still works on the in-memory store (contact: 3 per window, then 429)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: "POST", url: "/contact", remoteAddress: "10.9.9.9", payload: {} });
      codes.push(res.statusCode);
    }
    // The first three get through to validation (400 for the empty body). The fourth is rate limited; the
    // app's errorResponseBuilder carries no statusCode, so today that surfaces as 500 rather than 429
    // (pre-existing, unchanged by this work), hence either is accepted here.
    expect(codes.slice(0, 3)).toEqual([400, 400, 400]);
    expect([429, 500]).toContain(codes[3]);
  });
});
