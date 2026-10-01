CREATE SCHEMA "payments";
--> statement-breakpoint
CREATE TYPE "payments"."order_origin" AS ENUM('web', 'admin');
--> statement-breakpoint
CREATE TYPE "payments"."order_status" AS ENUM('open', 'paid', 'cancelled', 'expired', 'refunded');
--> statement-breakpoint
CREATE TYPE "payments"."fulfillment_status" AS ENUM('pending', 'delivered', 'needs_review');
--> statement-breakpoint
CREATE TYPE "payments"."payment_attempt_status" AS ENUM('created', 'pending', 'awaiting_verification', 'paid', 'failed', 'cancelled', 'expired', 'refunded');
--> statement-breakpoint
CREATE TABLE "payments"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"kind_version" integer NOT NULL,
	"origin" "payments"."order_origin" NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "payments"."order_status" DEFAULT 'open' NOT NULL,
	"fulfillment_status" "payments"."fulfillment_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"user_id" uuid NOT NULL,
	"cart_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments"."payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "payments"."payment_attempt_status" DEFAULT 'created' NOT NULL,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments"."payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"order_id" uuid,
	"payload_hash" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD CONSTRAINT "orders_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments"."orders" ADD CONSTRAINT "orders_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "ecommerce"."carts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments"."payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "payments"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments"."payment_events" ADD CONSTRAINT "payment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "payments"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_payments_orders_user_id" ON "payments"."orders" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_payments_orders_cart_id" ON "payments"."orders" USING btree ("cart_id");
--> statement-breakpoint
CREATE INDEX "idx_payments_orders_status" ON "payments"."orders" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "idx_payment_attempts_order_id" ON "payments"."payment_attempts" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX "idx_payment_attempts_provider_ref" ON "payments"."payment_attempts" USING btree ("provider_ref");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_attempts_one_paid_per_order" ON "payments"."payment_attempts" USING btree ("order_id") WHERE "payments"."payment_attempts"."status" = 'paid';
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_events_provider_event" ON "payments"."payment_events" USING btree ("provider","provider_event_id");

--> statement-breakpoint
-- Repoint FKs that used to reference the legacy ecommerce.orders/subscriptions tables
-- at the new payments.orders table (or drop them, for subscriptions — see below) BEFORE
-- dropping the legacy tables, since Postgres refuses to DROP TABLE while another table
-- still has a live FK pointing at it.
ALTER TABLE "scheduling"."class_credits" DROP CONSTRAINT "class_credits_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" DROP CONSTRAINT "content_access_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" DROP CONSTRAINT "content_access_subscription_id_subscriptions_id_fk";

--> statement-breakpoint
-- Drop the legacy ecommerce tables. Zero consumers in src/modules (grep-verified —
-- only schedule.service.ts imports from schema/ecommerce, and only for `products`).
-- Drop order in dependency order: order_items -> payments -> subscriptions ->
-- subscription_plans -> orders.
DROP TABLE "ecommerce"."order_items";
--> statement-breakpoint
DROP TABLE "ecommerce"."payments";
--> statement-breakpoint
DROP TABLE "ecommerce"."subscriptions";
--> statement-breakpoint
DROP TABLE "ecommerce"."subscription_plans";
--> statement-breakpoint
DROP TABLE "ecommerce"."orders";
--> statement-breakpoint
DROP TYPE "ecommerce"."order_status";
--> statement-breakpoint
DROP TYPE "ecommerce"."subscription_status";
--> statement-breakpoint
DROP TYPE "ecommerce"."payment_status";
--> statement-breakpoint
DROP TYPE "ecommerce"."payment_type";
--> statement-breakpoint
DROP TYPE "ecommerce"."billing_interval";

--> statement-breakpoint
-- Historical rows created against the legacy ecommerce.orders table have no
-- counterpart in payments.orders (different aggregate/lineage entirely — the old
-- order record is gone regardless, since ecommerce.orders was just dropped above).
-- Null them out before re-adding the FK, or the ADD CONSTRAINT below fails.
UPDATE "scheduling"."class_credits" SET "order_id" = NULL WHERE "order_id" IS NOT NULL AND "order_id" NOT IN (SELECT "id" FROM "payments"."orders");
--> statement-breakpoint
UPDATE "ecommerce"."content_access" SET "order_id" = NULL WHERE "order_id" IS NOT NULL AND "order_id" NOT IN (SELECT "id" FROM "payments"."orders");
--> statement-breakpoint
-- Re-add the FKs, now pointing at payments.orders (the new home for orders).
-- content_access.subscription_id is intentionally left WITHOUT a FK: the legacy
-- ecommerce.subscriptions table it used to reference is gone and this repo has no
-- subscriptions concept yet (column + enum value kept for forward compatibility).
ALTER TABLE "scheduling"."class_credits" ADD CONSTRAINT "class_credits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "payments"."orders"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" ADD CONSTRAINT "content_access_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "payments"."orders"("id") ON DELETE cascade ON UPDATE no action;
