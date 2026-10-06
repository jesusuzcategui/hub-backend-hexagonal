-- Busy times read from the owner's Nextcloud calendar are stored next to the manual blocks so every existing
-- consumer (slot listing, booking check, series classification) keeps working through the same overlap query.
-- drizzle runs the whole migration in one transaction; do not wrap it in BEGIN/COMMIT.
-- Existing rows become source = 'manual' and are never touched by the sync.

ALTER TABLE "scheduling"."blocked_slots" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "scheduling"."blocked_slots" ADD COLUMN "external_key" text;
--> statement-breakpoint
ALTER TABLE "scheduling"."blocked_slots" ADD COLUMN "external_summary" text;
--> statement-breakpoint
ALTER TABLE "scheduling"."blocked_slots" ADD COLUMN "synced_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scheduling"."blocked_slots" ADD CONSTRAINT "blocked_slots_source_check" CHECK ("source" IN ('manual', 'caldav'));
--> statement-breakpoint
ALTER TABLE "scheduling"."blocked_slots" ADD CONSTRAINT "blocked_slots_caldav_key_check" CHECK ("source" <> 'caldav' OR "external_key" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_blocked_slots_caldav_key" ON "scheduling"."blocked_slots" USING btree ("source", "external_key") WHERE "source" = 'caldav';
