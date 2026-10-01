CREATE TABLE "ecommerce"."payment_method_settings" (
	"method" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "ecommerce"."payment_method_settings" ("method") VALUES ('epayco'), ('paypal'), ('manual_transfer') ON CONFLICT DO NOTHING;
