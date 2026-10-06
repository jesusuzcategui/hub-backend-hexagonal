import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static assertions on the SQL text (no Postgres in unit tests). The behavior is exercised by the
// DB-backed reminders integration suite, which runs the real migration on a throwaway database.
const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0016_class_reminders.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

describe("migration 0016_class_reminders", () => {
  it("is registered right after 0015 with a strictly greater `when`", () => {
    const entries: Array<{ tag: string; idx: number; when: number }> = journal.entries;
    const entry = entries.find((e) => e.tag === "0016_class_reminders")!;
    expect(entry.idx).toBe(16);
    const before = entries.filter((e) => e.idx < 16);
    expect(before[before.length - 1].tag).toBe("0015_wp_product_source");
    expect(entry.when).toBeGreaterThan(Math.max(...before.map((e) => e.when)));
  });

  it("adds accounts.locale NOT NULL DEFAULT 'es' constrained to es/en", () => {
    expect(sql).toMatch(/ALTER TABLE "users"\."accounts" ADD COLUMN "locale" text DEFAULT 'es' NOT NULL/);
    expect(sql).toMatch(/CHECK \("locale" IN \('es', 'en'\)\)/);
  });

  it("adds the two nullable reminder columns and leaves the legacy one alone", () => {
    expect(sql).toMatch(/ADD COLUMN "reminder_24h_sent_at" timestamp with time zone/);
    expect(sql).toMatch(/ADD COLUMN "reminder_1h_sent_at" timestamp with time zone/);
    expect(sql).not.toMatch(/"reminder_sent_at"/);
    expect(sql).not.toMatch(/reminder_(24h|1h)_sent_at" timestamp with time zone NOT NULL/);
  });

  it("adds a partial index over confirmed bookings for the reminder scan", () => {
    expect(sql).toMatch(/CREATE INDEX "idx_bookings_reminder_scan" ON "scheduling"\."bookings" USING btree \("starts_at"\) WHERE "status" = 'confirmed'/);
  });
});
