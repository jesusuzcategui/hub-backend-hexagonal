-- Recurring class series: one row per series, bookings point back to it via series_id.
-- drizzle runs the whole migration in one transaction; do not wrap it in BEGIN/COMMIT.

CREATE TABLE "scheduling"."booking_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"pattern" jsonb NOT NULL,
	"interval_weeks" smallint NOT NULL,
	"start_date" date NOT NULL,
	"requested_occurrences" smallint NOT NULL,
	"created_occurrences" smallint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_series_status_check" CHECK ("status" IN ('active', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "scheduling"."booking_series" ADD CONSTRAINT "booking_series_student_id_accounts_id_fk" FOREIGN KEY ("student_id") REFERENCES "users"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduling"."booking_series" ADD CONSTRAINT "booking_series_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"."accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD COLUMN "series_id" uuid;
--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD CONSTRAINT "bookings_series_id_booking_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "scheduling"."booking_series"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_bookings_series_id" ON "scheduling"."bookings" USING btree ("series_id");
--> statement-breakpoint
CREATE INDEX "idx_booking_series_student_id" ON "scheduling"."booking_series" USING btree ("student_id");
