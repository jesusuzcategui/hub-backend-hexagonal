-- Replace single price_cents/currency with dual COP/USD pricing on products table
ALTER TABLE "ecommerce"."products"
  DROP COLUMN "price_cents",
  DROP COLUMN "currency",
  ADD COLUMN "price_cop" integer NOT NULL DEFAULT 0,
  ADD COLUMN "price_usd" integer NOT NULL DEFAULT 0;
