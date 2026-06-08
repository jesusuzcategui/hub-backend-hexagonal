import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./users";

export const ecommerceSchema = pgSchema("ecommerce");

export const orderStatusEnum = ecommerceSchema.enum("order_status", [
  "pending",
  "paid",
  "failed",
  "refunded",
  "cancelled",
]);

export const subscriptionStatusEnum = ecommerceSchema.enum("subscription_status", [
  "pending",
  "active",
  "paused",
  "cancelled",
  "expired",
]);

export const paymentStatusEnum = ecommerceSchema.enum("payment_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "refunded",
  "in_mediation",
  "charged_back",
]);

export const paymentTypeEnum = ecommerceSchema.enum("payment_type", [
  "one_time",
  "subscription_charge",
]);

export const billingIntervalEnum = ecommerceSchema.enum("billing_interval", [
  "days",
  "weeks",
  "months",
  "years",
]);

export const accessReasonEnum = ecommerceSchema.enum("access_reason", [
  "order",
  "subscription",
]);

export const products = ecommerceSchema.table(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strapiDocumentId: text("strapi_document_id").notNull().unique(),
    strapiContentType: text("strapi_content_type").notNull(),
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
    index("idx_products_strapi_doc_id").on(table.strapiDocumentId),
  ],
);

export const subscriptionPlans = ecommerceSchema.table("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  mpPreapprovalPlanId: text("mp_preapproval_plan_id").unique(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("ARS"),
  billingInterval: billingIntervalEnum("billing_interval").notNull(),
  billingFrequency: smallint("billing_frequency").notNull().default(1),
  trialDays: smallint("trial_days").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = ecommerceSchema.table(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    status: orderStatusEnum("status").notNull().default("pending"),
    subtotalCents: integer("subtotal_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("ARS"),
    mpPreferenceId: text("mp_preference_id"),
    mpExternalRef: text("mp_external_ref").unique(),
    metadata: jsonb("metadata").notNull().default({}),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_orders_user_status").on(table.userId, table.status),
    index("idx_orders_mp_external_ref").on(table.mpExternalRef),
  ],
);

export const orderItems = ecommerceSchema.table(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: smallint("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    snapshot: jsonb("snapshot").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_order_items_order_id").on(table.orderId)],
);

export const subscriptions = ecommerceSchema.table(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: "restrict" }),
    status: subscriptionStatusEnum("status").notNull().default("pending"),
    mpPreapprovalId: text("mp_preapproval_id").unique(),
    mpExternalRef: text("mp_external_ref").unique(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_subscriptions_user_status").on(table.userId, table.status),
    index("idx_subscriptions_mp_id").on(table.mpPreapprovalId),
  ],
);

export const payments = ecommerceSchema.table(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "restrict",
    }),
    paymentType: paymentTypeEnum("payment_type").notNull(),
    status: paymentStatusEnum("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("ARS"),
    mpPaymentId: text("mp_payment_id"),
    mpRawWebhook: jsonb("mp_raw_webhook"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_payments_mp_id")
      .on(table.mpPaymentId)
      .where(sql`${table.mpPaymentId} IS NOT NULL`),
  ],
);

export const contentAccess = ecommerceSchema.table(
  "content_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    strapiContentType: text("strapi_content_type").notNull(),
    strapiDocumentId: text("strapi_document_id").notNull(),
    reason: accessReasonEnum("reason").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_content_access_order")
      .on(table.userId, table.strapiContentType, table.strapiDocumentId, table.orderId)
      .where(sql`${table.reason} = 'order' AND ${table.orderId} IS NOT NULL`),
    uniqueIndex("uq_content_access_subscription")
      .on(
        table.userId,
        table.strapiContentType,
        table.strapiDocumentId,
        table.subscriptionId,
      )
      .where(
        sql`${table.reason} = 'subscription' AND ${table.subscriptionId} IS NOT NULL`,
      ),
    index("idx_content_access_active")
      .on(table.userId, table.strapiContentType, table.strapiDocumentId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);
