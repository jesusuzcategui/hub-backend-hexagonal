CREATE TABLE "scheduling"."mentoring_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "whatsapp" text,
  "type" text NOT NULL,
  "message" text,
  "slot_id" text NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "gcal_event_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_mentoring_requests_slot_id" ON "scheduling"."mentoring_requests" ("slot_id");
--> statement-breakpoint
CREATE INDEX "idx_mentoring_requests_starts_at" ON "scheduling"."mentoring_requests" ("starts_at");
--> statement-breakpoint
CREATE INDEX "idx_mentoring_requests_status" ON "scheduling"."mentoring_requests" ("status");
