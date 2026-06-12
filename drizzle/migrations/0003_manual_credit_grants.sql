ALTER TABLE "scheduling"."class_credits" ALTER COLUMN "order_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "scheduling"."class_credits" ADD COLUMN "granted_by" uuid;
--> statement-breakpoint
ALTER TABLE "scheduling"."class_credits" ADD COLUMN "payment_method" text;
--> statement-breakpoint
ALTER TABLE "scheduling"."class_credits" ADD COLUMN "grant_notes" text;
--> statement-breakpoint
ALTER TABLE "scheduling"."class_credits" ADD CONSTRAINT "class_credits_granted_by_accounts_id_fk" FOREIGN KEY ("granted_by") REFERENCES "users"."accounts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
