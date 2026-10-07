import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static assertions on the SQL text (no Postgres in unit tests). Behavior is exercised by the DB-backed
// calendar sync integration suite, which runs the real migration on a throwaway database.
const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0019_blocked_slots_caldav.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

describe("migration 0019_blocked_slots_caldav", () => {
  it("is registered right after 0018 with a strictly greater `when`", () => {
    const entry = journal.entries.find((e: { tag: string }) => e.tag === "0019_blocked_slots_caldav");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(19);
    const prev = journal.entries.find((e: { idx: number }) => e.idx === 18);
    expect(prev.tag).toBe("0018_order_review_reason");
    expect(entry.when).toBeGreaterThan(1791504000000);
    const maxOther = Math.max(...journal.entries.filter((e: { idx: number }) => e.idx < 19).map((e: { when: number }) => e.when));
    expect(entry.when).toBeGreaterThan(maxOther);
  });

  it("adds source with a default of 'manual' so existing rows stay manual, restricted to manual|caldav", () => {
    expect(sql).toMatch(/ADD COLUMN "source" text DEFAULT 'manual' NOT NULL/);
    expect(sql).toMatch(/CHECK \("source" IN \('manual', 'caldav'\)\)/);
  });

  it("adds the nullable external columns", () => {
    expect(sql).toMatch(/ADD COLUMN "external_key" text;/);
    expect(sql).toMatch(/ADD COLUMN "external_summary" text;/);
    expect(sql).toMatch(/ADD COLUMN "synced_at" timestamp with time zone;/);
  });

  it("makes (source, external_key) unique only for caldav rows", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "uq_blocked_slots_caldav_key" ON "scheduling"\."blocked_slots" USING btree \("source", "external_key"\) WHERE "source" = 'caldav'/);
  });

  it("requires an external_key on every caldav row", () => {
    expect(sql).toMatch(/CHECK \("source" <> 'caldav' OR "external_key" IS NOT NULL\)/);
  });
});
