import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static assertions on the SQL text (no Postgres in unit tests). Behavior is exercised by the DB-backed
// payment auto-verification integration suite, which runs the real migration on a throwaway database.
const root = join(__dirname, "..", "..", "..", "drizzle", "migrations");
const sql = readFileSync(join(root, "0018_order_review_reason.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));

describe("migration 0018_order_review_reason", () => {
  it("is registered right after 0017 with a strictly greater `when`", () => {
    const last = journal.entries.find((e: { tag: string }) => e.tag === "0018_order_review_reason");
    expect(last).toBeDefined();
    expect(last.idx).toBe(18);
    const prev = journal.entries.find((e: { idx: number }) => e.idx === 17);
    expect(prev.tag).toBe("0017_booking_series");
    expect(last.when).toBeGreaterThan(1791417600000);
    const maxOther = Math.max(...journal.entries.filter((e: { idx: number }) => e.idx < 18).map((e: { when: number }) => e.when));
    expect(last.when).toBeGreaterThan(maxOther);
  });

  it("adds the review columns to payments.orders, all nullable or defaulted (existing rows stay valid)", () => {
    expect(sql).toMatch(/ALTER TABLE "payments"\."orders" ADD COLUMN "review_reason" text;/);
    expect(sql).toMatch(/ADD COLUMN "review_flagged_at" timestamp with time zone;/);
    expect(sql).toMatch(/ADD COLUMN "review_verify_attempts" smallint DEFAULT 0 NOT NULL;/);
    expect(sql).toMatch(/ADD COLUMN "review_next_verify_at" timestamp with time zone;/);
    expect(sql).toMatch(/ADD COLUMN "review_provider_ref" text;/);
    expect(sql).toMatch(/ADD COLUMN "review_alerted_at" timestamp with time zone;/);
  });

  it("restricts review_reason to the known reasons (NULL allowed for legacy rows)", () => {
    expect(sql).toMatch(
      /CHECK \("review_reason" IS NULL OR "review_reason" IN \('contraste_unavailable', 'fulfillment_failed', 'contraste_mismatch'\)\)/,
    );
  });

  it("adds a partial index for the cron scan that only covers orders still waiting for a retry", () => {
    expect(sql).toMatch(/CREATE INDEX "idx_payments_orders_review_scan" ON "payments"\."orders" USING btree \("review_next_verify_at"\)/);
    expect(sql).toMatch(/WHERE "review_reason" = 'contraste_unavailable' AND "fulfillment_status" = 'needs_review' AND "review_next_verify_at" IS NOT NULL/);
  });

  it("creates the review audit trail table, deleted with its order", () => {
    expect(sql).toMatch(/CREATE TABLE "payments"\."order_review_events"/);
    expect(sql).toMatch(/"order_id" uuid NOT NULL/);
    expect(sql).toMatch(/"kind" text NOT NULL/);
    expect(sql).toMatch(/"detail" jsonb DEFAULT '\{\}'::jsonb NOT NULL/);
    expect(sql).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
    expect(sql).toMatch(/FOREIGN KEY \("order_id"\) REFERENCES "payments"\."orders"\("id"\) ON DELETE cascade/);
    expect(sql).toMatch(/CREATE INDEX "idx_order_review_events_order_id" ON "payments"\."order_review_events" USING btree \("order_id", "created_at"\)/);
  });
});
