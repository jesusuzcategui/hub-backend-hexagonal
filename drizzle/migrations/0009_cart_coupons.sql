CREATE TYPE "ecommerce"."cart_status" AS ENUM('open', 'converted', 'abandoned');
--> statement-breakpoint
CREATE TYPE "ecommerce"."coupon_type" AS ENUM('percent', 'fixed');
--> statement-breakpoint
CREATE TABLE "ecommerce"."carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"buyer_email" text,
	"buyer_name" text,
	"buyer_whatsapp" text,
	"currency" text,
	"locale" text,
	"status" "ecommerce"."cart_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_carts_status" ON "ecommerce"."carts" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "ecommerce"."coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" "ecommerce"."coupon_type" NOT NULL,
	"value" integer NOT NULL,
	"currency" text,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_coupons_code" ON "ecommerce"."coupons" USING btree ("code");
--> statement-breakpoint
DROP INDEX "ecommerce"."idx_orders_mp_external_ref";
--> statement-breakpoint
ALTER TABLE "ecommerce"."orders" DROP CONSTRAINT "orders_mp_external_ref_unique";
--> statement-breakpoint
ALTER TABLE "ecommerce"."orders" DROP COLUMN "gateway";
--> statement-breakpoint
ALTER TABLE "ecommerce"."orders" DROP COLUMN "mp_preference_id";
--> statement-breakpoint
ALTER TABLE "ecommerce"."orders" DROP COLUMN "mp_external_ref";
--> statement-breakpoint
DROP INDEX "ecommerce"."idx_payments_mp_id";
--> statement-breakpoint
ALTER TABLE "ecommerce"."payments" DROP COLUMN "mp_payment_id";
--> statement-breakpoint
ALTER TABLE "ecommerce"."payments" DROP COLUMN "mp_raw_webhook";
