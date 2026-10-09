import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./users";
import { orders as paymentsOrders } from "./payments";

export const ecommerceSchema = pgSchema("ecommerce");

// NOTE: the legacy `orders`, `order_items`, `payments`, `subscriptions`,
// `subscription_plans` tables (and their enums: order_status, subscription_status,
// payment_status, payment_type, billing_interval) were dropped in the
// hexagonal-payments-core migration (see drizzle/migrations for the DROP SQL).
// They had zero consumers in src/modules — grep-verified. Orders now live in
// `payments.orders` (src/db/schema/payments.ts), owned by hexagonal-payments-core's
// `Order` aggregate.

export const accessReasonEnum = ecommerceSchema.enum("access_reason", [
  "order",
  "subscription",
]);

export const cartStatusEnum = ecommerceSchema.enum("cart_status", [
  "open",
  "converted",
  "abandoned",
]);

export const couponTypeEnum = ecommerceSchema.enum("coupon_type", ["percent", "fixed"]);

export const products = ecommerceSchema.table(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id").notNull().unique(),
    contentType: text("content_type").notNull(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    priceCop: integer("price_cop").notNull().default(0),
    priceUsd: integer("price_usd").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_products_slug").on(table.slug),
    index("idx_products_external_id").on(table.externalId),
  ],
);

// `id` doubles as the public opaque token used at /cart/:token on the storefront.
// Postgres' default UUID v4 generator (gen_random_uuid()) keeps it non-sequential
// and non-guessable without adding a separate token column.
export const carts = ecommerceSchema.table(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    items: jsonb("items").notNull().default([]), // Array<{ planId: string; qty: number }>, validated with zod at the service layer
    buyerEmail: text("buyer_email"),
    buyerName: text("buyer_name"),
    buyerWhatsapp: text("buyer_whatsapp"),
    currency: text("currency"),
    locale: text("locale"),
    status: cartStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [index("idx_carts_status").on(table.status)],
);

// `code` is normalized to uppercase on write (see cart.service.ts) so the unique index
// enforces case-insensitive uniqueness without a citext extension dependency.
export const coupons = ecommerceSchema.table(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    type: couponTypeEnum("type").notNull(),
    value: integer("value").notNull(), // percent: 0-100, fixed: minor units of `currency`
    currency: text("currency"), // only meaningful when type = "fixed"
    maxRedemptions: integer("max_redemptions"), // null = unlimited
    redeemedCount: integer("redeemed_count").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_coupons_code").on(table.code),
    check("coupons_redemption_limit_check", sql`${table.maxRedemptions} IS NULL OR ${table.redeemedCount} <= ${table.maxRedemptions}`),
  ],
);

// One row per payment method ("epayco" | "paypal" | "manual_transfer"),
// seeded enabled=true by the migration. Lets an admin kill a method at
// runtime (a provider having a bad day) without a deploy — checkout()
// checks this before creating an attempt, so it's a real gate, not just a
// hidden button on the storefront.
export const paymentMethodSettings = ecommerceSchema.table("payment_method_settings", {
  method: text("method").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contentAccess = ecommerceSchema.table(
  "content_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contentType: text("content_type").notNull(),
    externalId: text("external_id").notNull(),
    reason: accessReasonEnum("reason").notNull(),
    // References payments.orders (hexagonal-payments-core's Order aggregate) —
    // the legacy ecommerce.orders/subscriptions tables it used to point to were dropped.
    orderId: uuid("order_id").references(() => paymentsOrders.id, { onDelete: "cascade" }),
    // No FK: the legacy ecommerce.subscriptions table was dropped and this repo has no
    // subscriptions concept yet. Column + enum value kept for forward compatibility.
    subscriptionId: uuid("subscription_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_content_access_order")
      .on(table.userId, table.contentType, table.externalId, table.orderId)
      .where(sql`${table.reason} = 'order' AND ${table.orderId} IS NOT NULL`),
    uniqueIndex("uq_content_access_subscription")
      .on(
        table.userId,
        table.contentType,
        table.externalId,
        table.subscriptionId,
      )
      .where(
        sql`${table.reason} = 'subscription' AND ${table.subscriptionId} IS NOT NULL`,
      ),
    index("idx_content_access_active")
      .on(table.userId, table.contentType, table.externalId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);
