-- redeemed_count can never pass max_redemptions. The settlement increment is guarded in the hub; this makes the
-- database refuse an overflow from any other path too. Unlimited coupons (NULL max_redemptions) are untouched.
-- NOT VALID: enforced on every new write, existing rows are not checked, so a coupon already over its limit
-- (possible with the unguarded increment this replaces) cannot block the deploy. To find and fix those, then
-- VALIDATE CONSTRAINT in a later migration:
--   SELECT id, code, redeemed_count, max_redemptions FROM ecommerce.coupons
--   WHERE max_redemptions IS NOT NULL AND redeemed_count > max_redemptions;
-- drizzle runs the whole migration in one transaction; do not wrap it in BEGIN/COMMIT.

ALTER TABLE "ecommerce"."coupons" ADD CONSTRAINT "coupons_redemption_limit_check" CHECK ("max_redemptions" IS NULL OR "redeemed_count" <= "max_redemptions") NOT VALID;
