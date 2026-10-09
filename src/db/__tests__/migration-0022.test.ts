import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0022_coupons_redemption_limit_check.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

describe("migration 0022_coupons_redemption_limit_check", () => {
  it("is registered right after 0021 with a strictly greater `when`", () => {
    const e = journal.entries.find((x: { tag: string }) => x.tag === "0022_coupons_redemption_limit_check");
    expect(e.idx).toBe(22);
    const maxOther = Math.max(...journal.entries.filter((x: { idx: number }) => x.idx < 22).map((x: { when: number }) => x.when));
    expect(e.when).toBeGreaterThan(maxOther);
  });
  it("adds a NOT VALID CHECK (new writes only, cannot fail on existing rows) that leaves unlimited coupons alone", () => {
    expect(sql).toMatch(/ADD CONSTRAINT "coupons_redemption_limit_check" CHECK \("max_redemptions" IS NULL OR "redeemed_count" <= "max_redemptions"\) NOT VALID;/);
    expect(sql).not.toMatch(/DROP/);
  });
});
