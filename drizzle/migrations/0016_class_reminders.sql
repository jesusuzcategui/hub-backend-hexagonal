-- Class reminders: student language + per-reminder sent flags.
-- drizzle runs the whole migration in one transaction; do not wrap it in BEGIN/COMMIT.

-- 1. Student language used to pick the email template (es | en). Existing accounts default to 'es'.
ALTER TABLE "users"."accounts" ADD COLUMN "locale" text DEFAULT 'es' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users"."accounts" ADD CONSTRAINT "accounts_locale_check" CHECK ("locale" IN ('es', 'en'));
--> statement-breakpoint

-- 2. One sent-at flag per reminder. The legacy reminder_sent_at column is intentionally untouched.
ALTER TABLE "scheduling"."bookings" ADD COLUMN "reminder_24h_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD COLUMN "reminder_1h_sent_at" timestamp with time zone;
--> statement-breakpoint

-- 3. The reminder scan only ever looks at confirmed bookings ordered by start time.
CREATE INDEX "idx_bookings_reminder_scan" ON "scheduling"."bookings" USING btree ("starts_at") WHERE "status" = 'confirmed';
