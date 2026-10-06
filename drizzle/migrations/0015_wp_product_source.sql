-- Products move from Strapi to headless WordPress (post type nodus_product).
-- Generic external key: strapi_document_id -> external_id, strapi_content_type -> content_type.
--
-- drizzle runs the whole migration inside a single transaction, so any failure rolls everything back.
-- Run it once. Do not wrap it in another BEGIN/COMMIT.
--
-- ORDER MATTERS: content_access is re-pointed first, joining on the OLD products ids,
-- BEFORE products.strapi_document_id is overwritten. Otherwise paid grants would stop matching.

-- 1. Re-point existing grants (old Strapi ids -> WP post ids), matching products by their OLD ids.
UPDATE "ecommerce"."content_access" AS ca
SET "strapi_document_id" = m."external_id",
    "strapi_content_type" = 'nodus_product'
FROM "ecommerce"."products" AS p
JOIN (VALUES
  ('single-session', '75'),
  ('basic', '76'),
  ('starter', '77'),
  ('plus', '78')
) AS m("slug", "external_id") ON m."slug" = p."slug"
WHERE ca."strapi_document_id" = p."strapi_document_id"
  AND ca."strapi_content_type" = p."strapi_content_type";
--> statement-breakpoint

-- 2. Backfill products with the WP post ids (only the 4 known slugs; anything else keeps its old values).
UPDATE "ecommerce"."products" AS p
SET "strapi_document_id" = m."external_id",
    "strapi_content_type" = 'nodus_product'
FROM (VALUES
  ('single-session', '75'),
  ('basic', '76'),
  ('starter', '77'),
  ('plus', '78')
) AS m("slug", "external_id")
WHERE p."slug" = m."slug";
--> statement-breakpoint

-- 3. Rename columns (indexes follow their columns automatically).
ALTER TABLE "ecommerce"."products" RENAME COLUMN "strapi_document_id" TO "external_id";
--> statement-breakpoint
ALTER TABLE "ecommerce"."products" RENAME COLUMN "strapi_content_type" TO "content_type";
--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" RENAME COLUMN "strapi_document_id" TO "external_id";
--> statement-breakpoint
ALTER TABLE "ecommerce"."content_access" RENAME COLUMN "strapi_content_type" TO "content_type";
--> statement-breakpoint

-- 4. Rename the constraint/index names that mention strapi.
--    (uq_content_access_order, uq_content_access_subscription and idx_content_access_active keep their names.)
ALTER TABLE "ecommerce"."products" RENAME CONSTRAINT "products_strapi_document_id_unique" TO "products_external_id_unique";
--> statement-breakpoint
ALTER INDEX "ecommerce"."idx_products_strapi_doc_id" RENAME TO "idx_products_external_id";
