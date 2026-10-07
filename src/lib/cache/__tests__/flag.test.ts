import { describe, it, expect } from "vitest";
import { cacheEnabled } from "..";

describe("cacheEnabled", () => {
  it("is on exactly when Redis is configured, by default", () => {
    expect(cacheEnabled({}, true)).toBe(true);
    expect(cacheEnabled({}, false)).toBe(false);
    expect(cacheEnabled({ NODE_ENV: "production" }, true)).toBe(true);
  });

  it("CACHE_ENABLED=false turns it off even with Redis (case-insensitive)", () => {
    expect(cacheEnabled({ CACHE_ENABLED: "false" }, true)).toBe(false);
    expect(cacheEnabled({ CACHE_ENABLED: "FALSE" }, true)).toBe(false);
  });

  it("CACHE_ENABLED=true enables the in-memory cache without Redis", () => {
    expect(cacheEnabled({ CACHE_ENABLED: "true" }, false)).toBe(true);
  });

  it("is always off under NODE_ENV=test", () => {
    expect(cacheEnabled({ NODE_ENV: "test" }, true)).toBe(false);
    expect(cacheEnabled({ NODE_ENV: "test", CACHE_ENABLED: "true" }, true)).toBe(false);
  });
});
