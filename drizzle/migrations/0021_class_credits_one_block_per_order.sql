-- One credit block per paid order. Settlement is serialized in the hub, but if two settlements of the same
-- order ever run at once (a second replica, a bug) the second insert must fail instead of minting credits
-- twice. Manual admin grants carry NULL order_id and are not limited.
-- A unique index cannot be added NOT VALID: it refuses to build if duplicates already exist, which is the
-- right outcome (they are the bug this prevents). Run this against the target database before deploying:
--   SELECT order_id, count(*) FROM scheduling.class_credits WHERE order_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- drizzle runs the whole migration in one transaction.

CREATE UNIQUE INDEX "uq_class_credits_order_id" ON "scheduling"."class_credits" USING btree ("order_id") WHERE "order_id" IS NOT NULL;
