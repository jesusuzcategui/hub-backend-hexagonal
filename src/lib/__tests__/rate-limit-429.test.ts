import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";

// Every rate-limited route family must answer the (limit + 1)th request with a 429 RATE_LIMITED envelope.
const FAMILIES = [
  { name: "auth forgot-password", url: "/auth/forgot-password", limit: 5, ip: "10.1.0.1" },
  { name: "cart send-link", url: "/cart/some-token/send-link", limit: 5, ip: "10.1.0.2" },
  { name: "contact", url: "/contact", limit: 3, ip: "10.1.0.3" },
  { name: "portfolio book", url: "/public/book", limit: 20, ip: "10.1.0.4" },
];

describe("rate limit responds 429 RATE_LIMITED", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(FAMILIES)("$name: request limit+1 is 429 with envelope and headers", async ({ url, limit, ip }) => {
    let last;
    for (let i = 0; i <= limit; i++) {
      last = await app.inject({ method: "POST", url, remoteAddress: ip, payload: {} });
      if (i < limit) expect(last.statusCode).not.toBe(429);
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
    });
    expect(last!.headers["retry-after"]).toBeDefined();
    expect(last!.headers["x-ratelimit-limit"]).toBe(String(limit));
  });
});
