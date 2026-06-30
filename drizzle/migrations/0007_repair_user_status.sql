-- Idempotent repair: applies 0005 content safely even if tracking table says applied
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE t.typname = 'account_status' AND n.nspname = 'users'
  ) THEN
    CREATE TYPE "users"."account_status" AS ENUM('active', 'suspended', 'blocked', 'deleted');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "users"."accounts" ADD COLUMN IF NOT EXISTS "status" "users"."account_status" NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "users"."accounts" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users"."accounts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_status" ON "users"."accounts" USING btree ("status");
