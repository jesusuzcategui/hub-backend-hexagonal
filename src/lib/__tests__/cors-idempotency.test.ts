import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";

// The campus sends `Idempotency-Key` from the browser (custom header -> preflight) and may read
// `Idempotent-Replayed`; CORS must allow the first and expose the second.
describe("CORS for idempotent series creation", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  const preflight = (origin: string, headers: string) =>
    app.inject({
      method: "OPTIONS",
      url: "/schedule/series",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": headers },
    });

  it("allows the Idempotency-Key header in a preflight from an allowed origin", async () => {
    const res = await preflight("http://localhost:3402", "idempotency-key,content-type,authorization");
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3402");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect((res.headers["access-control-allow-headers"] as string).toLowerCase()).toContain("idempotency-key");
  });

  it("still rejects a preflight from a disallowed origin", async () => {
    const res = await preflight("https://evil.example", "idempotency-key");
    expect(res.statusCode).not.toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes Idempotent-Replayed and Retry-After to the browser", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:3402" } });
    const exposed = (res.headers["access-control-expose-headers"] as string).toLowerCase();
    expect(exposed).toContain("idempotent-replayed");
    expect(exposed).toContain("retry-after");
  });
});
