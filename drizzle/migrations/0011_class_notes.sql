CREATE TABLE "scheduling"."class_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"author_id" uuid,
	"content" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduling"."class_notes" ADD CONSTRAINT "class_notes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "scheduling"."bookings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduling"."class_notes" ADD CONSTRAINT "class_notes_author_id_accounts_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"."accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_class_notes_booking_id" ON "scheduling"."class_notes" USING btree ("booking_id");
