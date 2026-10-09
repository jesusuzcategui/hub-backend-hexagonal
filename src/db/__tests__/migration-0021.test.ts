import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0021_class_credits_one_block_per_order.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

describe("migration 0021_class_credits_one_block_per_order", () => {
  it("is registered right after 0020 with a strictly greater `when`", () => {
    const e = journal.entries.find((x: { tag: string }) => x.tag === "0021_class_credits_one_block_per_order");
    expect(e.idx).toBe(21);
    const maxOther = Math.max(...journal.entries.filter((x: { idx: number }) => x.idx < 21).map((x: { when: number }) => x.when));
    expect(e.when).toBeGreaterThan(maxOther);
  });
  it("adds a partial unique index on order_id that leaves manual grants (NULL order_id) alone", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "uq_class_credits_order_id" ON "scheduling"\."class_credits" .*\("order_id"\) WHERE "order_id" IS NOT NULL;/);
    expect(sql).not.toMatch(/ALTER TABLE|DROP/);
  });
});
