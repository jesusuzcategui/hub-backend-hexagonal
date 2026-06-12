CREATE TYPE "users"."account_status" AS ENUM('active', 'suspended', 'blocked', 'deleted');
--> statement-breakpoint
ALTER TABLE "users"."accounts" ADD COLUMN "status" "users"."account_status" NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "users"."accounts" ADD COLUMN "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users"."accounts" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "idx_accounts_status" ON "users"."accounts" ("status");
