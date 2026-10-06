-- Why an order is in fulfillment_status = 'needs_review', plus the state the automatic ePayco
-- re-verification needs. drizzle runs the whole migration in one transaction; do not wrap it in BEGIN/COMMIT.
-- Existing rows keep review_reason NULL (unknown legacy reason) and are never picked up by the cron.

ALTER TABLE "payments"."orders" ADD COLUMN "review_reason" text;
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD COLUMN "review_flagged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD COLUMN "review_verify_attempts" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD COLUMN "review_next_verify_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD COLUMN "review_provider_ref" text;
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD COLUMN "review_alerted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD CONSTRAINT "orders_review_reason_check" CHECK ("review_reason" IS NULL OR "review_reason" IN ('contraste_unavailable', 'fulfillment_failed', 'contraste_mismatch'));
--> statement-breakpoint
CREATE INDEX "idx_payments_orders_review_scan" ON "payments"."orders" USING btree ("review_next_verify_at") WHERE "review_reason" = 'contraste_unavailable' AND "fulfillment_status" = 'needs_review' AND "review_next_verify_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "payments"."order_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments"."order_review_events" ADD CONSTRAINT "order_review_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "payments"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_order_review_events_order_id" ON "payments"."order_review_events" USING btree ("order_id", "created_at");
