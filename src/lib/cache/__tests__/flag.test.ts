import { describe, it, expect } from "vitest";
import { cacheEnabled } from "..";

describe("cacheEnabled", () => {
  it("is on exactly when Redis is configured, by default", () => {
    expect(cacheEnabled({}, true)).toBe(true);
    expect(cacheEnabled({}, false)).toBe(false);
    expect(cacheEnabled({ NODE_ENV: "production" }, true)).toBe(true);
  });

  it("CACHE_ENABLED=false turns it off even with Redis (case-insensitive, trimmed)", () => {
    expect(cacheEnabled({ CACHE_ENABLED: "false" }, true)).toBe(false);
    expect(cacheEnabled({ CACHE_ENABLED: "FALSE" }, true)).toBe(false);
    expect(cacheEnabled({ CACHE_ENABLED: " false " }, true)).toBe(false);
  });

  it("CACHE_ENABLED=true enables the in-memory cache without Redis", () => {
    expect(cacheEnabled({ CACHE_ENABLED: "true" }, false)).toBe(true);
    expect(cacheEnabled({ CACHE_ENABLED: " True " }, false)).toBe(true);
  });

  // Documented behavior: only the literal words true/false are recognized. Anything else ("0", "no", "off",
  // whitespace-only, empty) is IGNORED and the default applies (on iff Redis is configured). In particular
  // "0"/"no"/"off" do NOT disable the cache: use "false".
  it.each(["0", "no", "off", "", " ", "yes", "1"])("unrecognized CACHE_ENABLED=%j falls back to the default", (value) => {
    expect(cacheEnabled({ CACHE_ENABLED: value }, true)).toBe(true);
    expect(cacheEnabled({ CACHE_ENABLED: value }, false)).toBe(false);
  });

  it("is always off under NODE_ENV=test", () => {
    expect(cacheEnabled({ NODE_ENV: "test" }, true)).toBe(false);
    expect(cacheEnabled({ NODE_ENV: "test", CACHE_ENABLED: "true" }, true)).toBe(false);
  });
});
