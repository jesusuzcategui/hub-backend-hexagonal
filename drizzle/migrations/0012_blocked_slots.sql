CREATE TABLE "scheduling"."blocked_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduling"."blocked_slots" ADD CONSTRAINT "blocked_slots_teacher_id_accounts_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "users"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_blocked_slots_teacher_id" ON "scheduling"."blocked_slots" USING btree ("teacher_id");
--> statement-breakpoint
CREATE INDEX "idx_blocked_slots_starts_at" ON "scheduling"."blocked_slots" USING btree ("starts_at");
