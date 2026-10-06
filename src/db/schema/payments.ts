import {
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
import { carts } from "./ecommerce";

// Owns the DB-side of hexagonal-payments-core's Order / PaymentAttempt / PaymentEvent
// aggregates. Kept as a separate schema from `ecommerce` so the clean payments domain
// (backed by the frozen, git-tag-pinned hexagonal-payments-core package) stays distinct
// from the legacy e-commerce leftovers still living in `ecommerce` (products, carts,
// coupons, content_access).

export const paymentsSchema = pgSchema("payments");

export const orderOriginEnum = paymentsSchema.enum("order_origin", ["web", "admin"]);

export const orderStatusEnum = paymentsSchema.enum("order_status", [
  "open",
  "paid",
  "cancelled",
  "expired",
  "refunded",
]);

export const fulfillmentStatusEnum = paymentsSchema.enum("fulfillment_status", [
  "pending",
  "delivered",
  "needs_review",
]);

export const paymentAttemptStatusEnum = paymentsSchema.enum("payment_attempt_status", [
  "created",
  "pending",
  "awaiting_verification",
  "paid",
  "failed",
  "cancelled",
  "expired",
  "refunded",
]);

// Translation layer for hexagonal-payments-core's `Order` aggregate (via
// Order.fromProps/.create — see src/adapters/payments/drizzle-order-repository.ts).
// `userId` and `cartId` are NOT part of the core's `Order` type; they are this app's
// own concern and are read back via raw queries (never forced into the core `Order`
// object) wherever needed, e.g. for granting credits / sending confirmation emails.
export const orders = paymentsSchema.table(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    kindVersion: integer("kind_version").notNull(),
    origin: orderOriginEnum("origin").notNull(),
    currency: text("currency").notNull(), // char(3), stored as text to match core's CurrencyCode (string)
    amountMinor: integer("amount_minor").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    status: orderStatusEnum("status").notNull().default("open"),
    fulfillmentStatus: fulfillmentStatusEnum("fulfillment_status").notNull().default("pending"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // App-owned review state (NOT part of the core's Order): why the order is in needs_review and the
    // bookkeeping of the automatic ePayco re-verification. See modules/payments/review-verification.ts.
    reviewReason: text("review_reason"),
    reviewFlaggedAt: timestamp("review_flagged_at", { withTimezone: true }),
    reviewVerifyAttempts: smallint("review_verify_attempts").notNull().default(0),
    reviewNextVerifyAt: timestamp("review_next_verify_at", { withTimezone: true }),
    reviewProviderRef: text("review_provider_ref"),
    reviewAlertedAt: timestamp("review_alerted_at", { withTimezone: true }),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    // Nullable: admin-created orders (origin = "admin") have no cart.
    cartId: uuid("cart_id").references(() => carts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_payments_orders_user_id").on(table.userId),
    index("idx_payments_orders_cart_id").on(table.cartId),
    index("idx_payments_orders_status").on(table.status),
    // Cron scan: only orders still waiting for an ePayco re-verification.
    index("idx_payments_orders_review_scan")
      .on(table.reviewNextVerifyAt)
      .where(
        sql`${table.reviewReason} = 'contraste_unavailable' AND ${table.fulfillmentStatus} = 'needs_review' AND ${table.reviewNextVerifyAt} IS NOT NULL`,
      ),
  ],
);

// Audit trail of everything that happens to an order while it is under review.
export const orderReviewEvents = paymentsSchema.table(
  "order_review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_order_review_events_order_id").on(table.orderId, table.createdAt)],
);

// Translation layer for hexagonal-payments-core's `PaymentAttempt` aggregate.
export const paymentAttempts = paymentsSchema.table(
  "payment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: paymentAttemptStatusEnum("status").notNull().default("created"),
    providerRef: text("provider_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_payment_attempts_order_id").on(table.orderId),
    index("idx_payment_attempts_provider_ref").on(table.providerRef),
    // DB-level enforcement of "only one paid attempt per order" — the core's
    // findPaidAttempt() check (in drizzle-payment-attempt-repository.ts) is the
    // defensive application-level mirror of this constraint.
    uniqueIndex("uq_payment_attempts_one_paid_per_order")
      .on(table.orderId)
      .where(sql`${table.status} = 'paid'`),
  ],
);

// Translation layer for hexagonal-payments-core's `PaymentEvent` (idempotency ledger).
export const paymentEvents = paymentsSchema.table(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    payloadHash: text("payload_hash").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_payment_events_provider_event").on(table.provider, table.providerEventId),
  ],
);
