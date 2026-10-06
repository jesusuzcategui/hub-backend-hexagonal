import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static assertions on the SQL text (no Postgres in unit tests). Behavior is exercised by the
// DB-backed series integration suite, which runs the real migration on a throwaway database.
const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0017_booking_series.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

describe("migration 0017_booking_series", () => {
  it("is registered right after 0016 with a strictly greater `when`", () => {
    const last = journal.entries[journal.entries.length - 1];
    expect(last.tag).toBe("0017_booking_series");
    expect(last.idx).toBe(17);
    const prev = journal.entries[journal.entries.length - 2];
    expect(prev.tag).toBe("0016_class_reminders");
    expect(last.when).toBeGreaterThan(prev.when);
    const maxOther = Math.max(...journal.entries.slice(0, -1).map((e: { when: number }) => e.when));
    expect(last.when).toBeGreaterThan(maxOther);
  });

  it("creates scheduling.booking_series with the agreed columns", () => {
    expect(sql).toMatch(/CREATE TABLE "scheduling"\."booking_series"/);
    expect(sql).toMatch(/"id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/);
    expect(sql).toMatch(/"student_id" uuid NOT NULL/);
    expect(sql).toMatch(/"created_by" uuid NOT NULL/);
    expect(sql).toMatch(/"pattern" jsonb NOT NULL/);
    expect(sql).toMatch(/"interval_weeks" smallint NOT NULL/);
    expect(sql).toMatch(/"start_date" date NOT NULL/);
    expect(sql).toMatch(/"requested_occurrences" smallint NOT NULL/);
    expect(sql).toMatch(/"created_occurrences" smallint NOT NULL/);
    expect(sql).toMatch(/"status" text DEFAULT 'active' NOT NULL/);
    expect(sql).toMatch(/CHECK \("status" IN \('active', 'cancelled'\)\)/);
    expect(sql).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
  });

  it("references users.accounts: student cascades, creator does not", () => {
    expect(sql).toMatch(/"student_id"\) REFERENCES "users"\."accounts"\("id"\) ON DELETE cascade/);
    expect(sql).toMatch(/"created_by"\) REFERENCES "users"\."accounts"\("id"\)(?! ON DELETE cascade)/);
  });

  it("adds a nullable bookings.series_id that is set null when the series is deleted", () => {
    expect(sql).toMatch(/ALTER TABLE "scheduling"\."bookings" ADD COLUMN "series_id" uuid;/);
    expect(sql).toMatch(/FOREIGN KEY \("series_id"\) REFERENCES "scheduling"\."booking_series"\("id"\) ON DELETE set null/);
  });

  it("indexes bookings(series_id) and booking_series(student_id)", () => {
    expect(sql).toMatch(/CREATE INDEX "idx_bookings_series_id" ON "scheduling"\."bookings" USING btree \("series_id"\)/);
    expect(sql).toMatch(/CREATE INDEX "idx_booking_series_student_id" ON "scheduling"\."booking_series" USING btree \("student_id"\)/);
  });
});
