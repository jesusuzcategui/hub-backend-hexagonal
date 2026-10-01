CREATE TABLE "users"."password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users"."password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_user" ON "users"."password_reset_tokens" USING btree ("user_id");
