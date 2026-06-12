CREATE TABLE "scheduling"."weekly_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "teacher_id" uuid NOT NULL,
  "day_of_week" smallint NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "scheduling"."weekly_slots" ADD CONSTRAINT "weekly_slots_teacher_id_accounts_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "users"."accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "idx_weekly_slots_teacher_id" ON "scheduling"."weekly_slots" ("teacher_id");
--> statement-breakpoint
CREATE INDEX "idx_weekly_slots_day_of_week" ON "scheduling"."weekly_slots" ("day_of_week");
--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ALTER COLUMN "availability_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD COLUMN "weekly_slot_id" uuid;
--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD CONSTRAINT "bookings_weekly_slot_id_weekly_slots_id_fk" FOREIGN KEY ("weekly_slot_id") REFERENCES "scheduling"."weekly_slots"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "idx_bookings_weekly_slot_id" ON "scheduling"."bookings" ("weekly_slot_id");
