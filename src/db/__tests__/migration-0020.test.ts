import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0020_booking_series_idempotency.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

describe("migration 0020_booking_series_idempotency", () => {
  it("is registered right after 0019 with a strictly greater `when`", () => {
    const e = journal.entries.find((x: { tag: string }) => x.tag === "0020_booking_series_idempotency");
    expect(e.idx).toBe(20);
    const maxOther = Math.max(...journal.entries.filter((x: { idx: number }) => x.idx < 20).map((x: { when: number }) => x.when));
    expect(e.when).toBeGreaterThan(maxOther);
  });
  it("adds only nullable columns (existing rows stay valid) and a partial unique index", () => {
    expect(sql).toMatch(/ADD COLUMN "idempotency_key" text;/);
    expect(sql).toMatch(/ADD COLUMN "request_fingerprint" text;/);
    expect(sql).toMatch(/ADD COLUMN "idempotency_response" jsonb;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "uq_booking_series_student_idempotency_key" .*\("student_id", "idempotency_key"\) WHERE "idempotency_key" IS NOT NULL;/);
  });
});
