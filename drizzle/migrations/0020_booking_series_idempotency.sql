-- Idempotent series creation: the client sends an Idempotency-Key and a retry gets the original result back.
-- The key, a fingerprint of the request and the original response live on the series row itself, written in the
-- same transaction that creates the series, so a series never exists without its key.
-- Existing rows keep NULL in all three columns (they were created without a key) and are never touched.
-- drizzle runs the whole migration in one transaction; do not wrap it in BEGIN/COMMIT.

ALTER TABLE "scheduling"."booking_series" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "scheduling"."booking_series" ADD COLUMN "request_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "scheduling"."booking_series" ADD COLUMN "idempotency_response" jsonb;
--> statement-breakpoint
ALTER TABLE "scheduling"."booking_series" ADD CONSTRAINT "booking_series_idempotency_check" CHECK ("idempotency_key" IS NULL OR "request_fingerprint" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_booking_series_student_idempotency_key" ON "scheduling"."booking_series" USING btree ("student_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
