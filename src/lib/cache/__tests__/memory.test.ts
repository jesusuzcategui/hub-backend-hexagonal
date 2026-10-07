import { describe, it, expect } from "vitest";
import { MemoryCache } from "../memory";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("MemoryCache", () => {
  it("returns what was stored and null on a miss", async () => {
    const c = new MemoryCache();
    await c.set("a", { x: 1 }, 60);
    expect(await c.get("a")).toEqual({ x: 1 });
    expect(await c.get("missing")).toBeNull();
  });

  it("does not share mutable objects with callers", async () => {
    const c = new MemoryCache();
    const v = { list: [1] };
    await c.set("a", v, 60);
    v.list.push(2);
    const got = await c.get<{ list: number[] }>("a");
    expect(got).toEqual({ list: [1] });
    got!.list.push(9);
    expect(await c.get("a")).toEqual({ list: [1] });
  });

  it("expires entries after their TTL (lazily, no timers)", async () => {
    const k = clock();
    const c = new MemoryCache({ now: k.now });
    await c.set("a", 1, 10);
    k.advance(9_999);
    expect(await c.get("a")).toBe(1);
    k.advance(2);
    expect(await c.get("a")).toBeNull();
    expect(c.size).toBe(0);
  });

  it("ignores non-positive TTLs", async () => {
    const c = new MemoryCache();
    await c.set("a", 1, 0);
    expect(await c.get("a")).toBeNull();
  });

  it("is bounded: evicts expired entries first, then the oldest", async () => {
    const k = clock();
    const c = new MemoryCache({ maxEntries: 3, now: k.now });
    await c.set("old", 1, 5);
    await c.set("b", 2, 100);
    await c.set("c", 3, 100);
    k.advance(6_000); // "old" is now expired
    await c.set("d", 4, 100);
    expect(c.size).toBe(3);
    expect(await c.get("old")).toBeNull();
    expect(await c.get("b")).toBe(2);

    await c.set("e", 5, 100); // nothing expired: oldest ("b") goes
    expect(c.size).toBe(3);
    expect(await c.get("b")).toBeNull();
    expect(await c.get("e")).toBe(5);
  });

  it("never grows past maxEntries under sustained writes", async () => {
    const c = new MemoryCache({ maxEntries: 50 });
    for (let i = 0; i < 500; i++) await c.set(`k${i}`, i, 60);
    expect(c.size).toBe(50);
  });

  it("deletes by key and by prefix", async () => {
    const c = new MemoryCache();
    await c.set("products:list", 1, 60);
    await c.set("products:slug:a", 2, 60);
    await c.set("payment-methods", 3, 60);
    await c.del("products:list");
    expect(await c.get("products:list")).toBeNull();
    expect(await c.get("products:slug:a")).toBe(2);
    await c.delByPrefix("products:");
    expect(await c.get("products:slug:a")).toBeNull();
    expect(await c.get("payment-methods")).toBe(3);
  });
});
