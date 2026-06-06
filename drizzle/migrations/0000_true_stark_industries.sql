CREATE SCHEMA "users";
--> statement-breakpoint
CREATE SCHEMA "ecommerce";
--> statement-breakpoint
CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "scheduling";
--> statement-breakpoint
CREATE TYPE "users"."provider_type" AS ENUM('google', 'github');--> statement-breakpoint
CREATE TYPE "users"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "ecommerce"."access_reason" AS ENUM('order', 'subscription');--> statement-breakpoint
CREATE TYPE "ecommerce"."billing_interval" AS ENUM('days', 'weeks', 'months', 'years');--> statement-breakpoint
CREATE TYPE "ecommerce"."order_status" AS ENUM('pending', 'paid', 'failed', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "ecommerce"."payment_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'in_mediation', 'charged_back');--> statement-breakpoint
CREATE TYPE "ecommerce"."payment_type" AS ENUM('one_time', 'subscription_charge');--> statement-breakpoint
CREATE TYPE "ecommerce"."subscription_status" AS ENUM('pending', 'active', 'paused', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "scheduling"."booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TABLE "users"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"role" "users"."user_role" DEFAULT 'user' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "users"."providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "users"."provider_type" NOT NULL,
	"provider_uid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "ecommerce"."content_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strapi_content_type" text NOT NULL,
	"strapi_document_id" text NOT NULL,
	"reason" "ecommerce"."access_reason" NOT NULL,
	"order_id" uuid,
	"subscription_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ecommerce"."order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" smallint DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ecommerce"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "ecommerce"."order_status" DEFAULT 'pending' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'ARS' NOT NULL,
	"mp_preference_id" text,
	"mp_external_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_mp_external_ref_unique" UNIQUE("mp_external_ref")
);
--> statement-breakpoint
CREATE TABLE "ecommerce"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid,
	"subscription_id" uuid,
	"payment_type" "ecommerce"."payment_type" NOT NULL,
	"status" "ecommerce"."payment_status" NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'ARS' NOT NULL,
	"mp_payment_id" text,
	"mp_raw_webhook" jsonb,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ecommerce"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strapi_document_id" text NOT NULL,
	"strapi_content_type" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'ARS' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_strapi_document_id_unique" UNIQUE("strapi_document_id"),
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ecommerce"."subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"mp_preapproval_plan_id" text,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'ARS' NOT NULL,
	"billing_interval" "ecommerce"."billing_interval" NOT NULL,
	"billing_frequency" smallint DEFAULT 1 NOT NULL,
	"trial_days" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_mp_preapproval_plan_id_unique" UNIQUE("mp_preapproval_plan_id")
);
--> statement-breakpoint
CREATE TABLE "ecommerce"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "ecommerce"."subscription_status" DEFAULT 'pending' NOT NULL,
	"mp_preapproval_id" text,
	"mp_external_ref" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_mp_preapproval_id_unique" UNIQUE("mp_preapproval_id"),
	CONSTRAINT "subscriptions_mp_external_ref_unique" UNIQUE("mp_external_ref")
);
--> statement-breakpoint
CREATE TABLE "app"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_id" uuid,
	"target_type" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" smallint NOT NULL,
	"duration_ms" integer NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling"."availabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"is_booked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling"."bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"credit_id" uuid NOT NULL,
	"availability_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "scheduling"."booking_status" DEFAULT 'pending' NOT NULL,
	"gcal_event_id" text,
	"meet_link" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"student_notes" text,
	"reminder_sent_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling"."class_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"total_credits" smallint NOT NULL,
	"used_credits" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users"."providers" ADD CONSTRAINT "providers_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" ADD CONSTRAINT "content_access_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" ADD CONSTRAINT "content_access_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "ecommerce"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" ADD CONSTRAINT "content_access_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "ecommerce"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "ecommerce"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "ecommerce"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."orders" ADD CONSTRAINT "orders_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."payments" ADD CONSTRAINT "payments_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "ecommerce"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "ecommerce"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."subscription_plans" ADD CONSTRAINT "subscription_plans_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "ecommerce"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."subscriptions" ADD CONSTRAINT "subscriptions_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecommerce"."subscriptions" ADD CONSTRAINT "subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "ecommerce"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audit_logs" ADD CONSTRAINT "audit_logs_actor_id_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."request_logs" ADD CONSTRAINT "request_logs_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."availabilities" ADD CONSTRAINT "availabilities_teacher_id_accounts_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "users"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD CONSTRAINT "bookings_student_id_accounts_id_fk" FOREIGN KEY ("student_id") REFERENCES "users"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD CONSTRAINT "bookings_credit_id_class_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "scheduling"."class_credits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD CONSTRAINT "bookings_availability_id_availabilities_id_fk" FOREIGN KEY ("availability_id") REFERENCES "scheduling"."availabilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."bookings" ADD CONSTRAINT "bookings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "ecommerce"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."class_credits" ADD CONSTRAINT "class_credits_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."class_credits" ADD CONSTRAINT "class_credits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "ecommerce"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling"."class_credits" ADD CONSTRAINT "class_credits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "ecommerce"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accounts_email" ON "users"."accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_uid" ON "users"."providers" USING btree ("provider","provider_uid");--> statement-breakpoint
CREATE INDEX "idx_providers_lookup" ON "users"."providers" USING btree ("provider","provider_uid");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_family" ON "users"."refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_access_order" ON "ecommerce"."content_access" USING btree ("user_id","strapi_content_type","strapi_document_id","order_id") WHERE "ecommerce"."content_access"."reason" = 'order' AND "ecommerce"."content_access"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_access_subscription" ON "ecommerce"."content_access" USING btree ("user_id","strapi_content_type","strapi_document_id","subscription_id") WHERE "ecommerce"."content_access"."reason" = 'subscription' AND "ecommerce"."content_access"."subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_content_access_active" ON "ecommerce"."content_access" USING btree ("user_id","strapi_content_type","strapi_document_id") WHERE "ecommerce"."content_access"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_order_items_order_id" ON "ecommerce"."order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_orders_user_status" ON "ecommerce"."orders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_orders_mp_external_ref" ON "ecommerce"."orders" USING btree ("mp_external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_payments_mp_id" ON "ecommerce"."payments" USING btree ("mp_payment_id") WHERE "ecommerce"."payments"."mp_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_products_slug" ON "ecommerce"."products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_products_strapi_doc_id" ON "ecommerce"."products" USING btree ("strapi_document_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_user_status" ON "ecommerce"."subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_mp_id" ON "ecommerce"."subscriptions" USING btree ("mp_preapproval_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor_id" ON "app"."audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "app"."audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "app"."audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_request_logs_user_id" ON "app"."request_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_request_logs_created_at" ON "app"."request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_request_logs_status" ON "app"."request_logs" USING btree ("status_code");--> statement-breakpoint
CREATE INDEX "idx_availabilities_starts_at" ON "scheduling"."availabilities" USING btree ("starts_at") WHERE "scheduling"."availabilities"."is_booked" = FALSE;--> statement-breakpoint
CREATE INDEX "idx_bookings_student_id" ON "scheduling"."bookings" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_bookings_starts_at" ON "scheduling"."bookings" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "idx_bookings_status" ON "scheduling"."bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_class_credits_user_id" ON "scheduling"."class_credits" USING btree ("user_id");