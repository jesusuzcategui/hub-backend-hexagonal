import { describe, it, expect } from "vitest";
import {
  DEFAULT_CREDIT_VALIDITY_DAYS,
  computeCreditExpiry,
  pickCreditBlock,
  resolveGrantExpiry,
  summarizeBalance,
} from "../credit-balance";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-06T12:00:00Z");

function block(over: Partial<Parameters<typeof pickCreditBlock>[0][number]> & { id: string }) {
  return {
    creditId: over.id,
    productName: "Plan",
    totalCredits: 4,
    usedCredits: 0,
    expiresAt: null as Date | null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

describe("computeCreditExpiry", () => {
  const grant = new Date("2026-10-06T12:00:00Z");

  it("adds validityDays to the grant date", () => {
    expect(computeCreditExpiry(grant, 90).getTime()).toBe(grant.getTime() + 90 * DAY);
  });

  it("falls back to 60 days when validity is undefined", () => {
    expect(DEFAULT_CREDIT_VALIDITY_DAYS).toBe(60);
    expect(computeCreditExpiry(grant, undefined).getTime()).toBe(grant.getTime() + 60 * DAY);
  });

  it.each([0, -5, Number.NaN, 1.5, Infinity])("falls back to 60 days for invalid validity %s", (v) => {
    expect(computeCreditExpiry(grant, v).getTime()).toBe(grant.getTime() + 60 * DAY);
  });

  it("does not mutate the grant date", () => {
    const g = new Date(grant);
    computeCreditExpiry(g, 60);
    expect(g.getTime()).toBe(grant.getTime());
  });
});

describe("pickCreditBlock", () => {
  it("returns null when there are no blocks", () => {
    expect(pickCreditBlock([], now)).toBeNull();
  });

  it("skips expired blocks (expiresAt <= now) and exhausted blocks", () => {
    const blocks = [
      block({ id: "expired", expiresAt: new Date(now.getTime() - 1) }),
      block({ id: "boundary", expiresAt: new Date(now.getTime()) }),
      block({ id: "used", totalCredits: 2, usedCredits: 2 }),
    ];
    expect(pickCreditBlock(blocks, now)).toBeNull();
  });

  it("picks the block that expires first", () => {
    const blocks = [
      block({ id: "later", expiresAt: new Date(now.getTime() + 30 * DAY) }),
      block({ id: "sooner", expiresAt: new Date(now.getTime() + 5 * DAY) }),
    ];
    expect(pickCreditBlock(blocks, now)?.id).toBe("sooner");
  });

  it("uses a block without expiry only after dated ones", () => {
    const blocks = [
      block({ id: "never", expiresAt: null, createdAt: new Date("2026-01-01T00:00:00Z") }),
      block({ id: "dated", expiresAt: new Date(now.getTime() + 90 * DAY) }),
    ];
    expect(pickCreditBlock(blocks, now)?.id).toBe("dated");
  });

  it("breaks expiry ties by the oldest purchase", () => {
    const exp = new Date(now.getTime() + 10 * DAY);
    const blocks = [
      block({ id: "newer", expiresAt: exp, createdAt: new Date("2026-09-20T00:00:00Z") }),
      block({ id: "older", expiresAt: exp, createdAt: new Date("2026-09-10T00:00:00Z") }),
    ];
    expect(pickCreditBlock(blocks, now)?.id).toBe("older");
  });

  it("breaks ties between non-expiring blocks by the oldest purchase", () => {
    const blocks = [
      block({ id: "newer", createdAt: new Date("2026-09-20T00:00:00Z") }),
      block({ id: "older", createdAt: new Date("2026-09-10T00:00:00Z") }),
    ];
    expect(pickCreditBlock(blocks, now)?.id).toBe("older");
  });

  it("does not mutate the input array", () => {
    const blocks = [
      block({ id: "b", expiresAt: new Date(now.getTime() + 9 * DAY) }),
      block({ id: "a", expiresAt: new Date(now.getTime() + 1 * DAY) }),
    ];
    pickCreditBlock(blocks, now);
    expect(blocks.map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("summarizeBalance", () => {
  it("sums remaining over valid blocks and reports the earliest expiry", () => {
    const soon = new Date(now.getTime() + 5 * DAY);
    const summary = summarizeBalance(
      [
        block({ id: "a", totalCredits: 8, usedCredits: 3, expiresAt: new Date(now.getTime() + 20 * DAY) }),
        block({ id: "b", totalCredits: 4, usedCredits: 1, expiresAt: soon }),
        block({ id: "dead", totalCredits: 4, usedCredits: 0, expiresAt: new Date(now.getTime() - DAY) }),
        block({ id: "empty", totalCredits: 2, usedCredits: 2 }),
      ],
      now,
    );

    expect(summary.balance).toBe(8);
    expect(summary.nextExpiry).toEqual(soon);
    expect(summary.blocks.map((b) => b.creditId)).toEqual(["b", "a"]);
    expect(summary.blocks[0]).toMatchObject({ creditId: "b", totalCredits: 4, usedCredits: 1, remaining: 3, expiresAt: soon });
  });

  it("ignores non-expiring blocks for nextExpiry", () => {
    const summary = summarizeBalance([block({ id: "n", totalCredits: 3 })], now);
    expect(summary.balance).toBe(3);
    expect(summary.nextExpiry).toBeNull();
  });

  it("returns an empty summary when nothing is usable", () => {
    expect(summarizeBalance([], now)).toEqual({ balance: 0, nextExpiry: null, blocks: [] });
  });
});

describe("resolveGrantExpiry", () => {
  const grant = new Date("2026-10-06T12:00:00Z");

  it("uses the product validityDays from its metadata", () => {
    expect(resolveGrantExpiry(grant, { creditsCount: 12, validityDays: 90 }).getTime()).toBe(grant.getTime() + 90 * DAY);
  });

  it("defaults to 60 days when the product has no validityDays or no metadata", () => {
    expect(resolveGrantExpiry(grant, { creditsCount: 4 }).getTime()).toBe(grant.getTime() + 60 * DAY);
    expect(resolveGrantExpiry(grant, null).getTime()).toBe(grant.getTime() + 60 * DAY);
    expect(resolveGrantExpiry(grant, undefined).getTime()).toBe(grant.getTime() + 60 * DAY);
  });

  it("accepts a numeric-string validityDays stored in metadata", () => {
    expect(resolveGrantExpiry(grant, { validityDays: "90" }).getTime()).toBe(grant.getTime() + 90 * DAY);
  });

  it("an explicit expiry (manual admin override) wins over the product validity", () => {
    const explicit = new Date("2027-01-01T00:00:00Z");
    expect(resolveGrantExpiry(grant, { validityDays: 90 }, explicit)).toEqual(explicit);
  });
});
