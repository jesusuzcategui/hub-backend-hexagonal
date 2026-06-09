ALTER TABLE "ecommerce"."orders" ADD COLUMN "gateway" text;

UPDATE "ecommerce"."orders" SET "gateway" = "metadata"->>'gateway' WHERE "metadata"->>'gateway' IS NOT NULL;
