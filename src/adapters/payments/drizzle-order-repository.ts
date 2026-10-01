import { eq } from "drizzle-orm";
import { Order, type OrderRepository, type CurrencyCode } from "hexagonal-payments-core";
import type { DrizzleDb } from "../../db";
import { orders, paymentAttempts } from "../../db/schema";

type OrderRow = typeof orders.$inferSelect;

function rowToOrder(row: OrderRow): Order {
  return Order.fromProps({
    id: row.id,
    kind: row.kind,
    kindVersion: row.kindVersion,
    origin: row.origin,
    currency: row.currency as CurrencyCode,
    amountMinor: row.amountMinor,
    metadata: row.metadata,
    status: row.status,
    fulfillmentStatus: row.fulfillmentStatus,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Implements hexagonal-payments-core's `OrderRepository` against `payments.orders`.
 *
 * `userId` and `cartId` are NOT part of the core's `Order` aggregate — they are this
 * app's own concern, stored in the same row, but never forced into the core `Order`
 * type. Because `save(order: Order)` only ever receives a core `Order` (no userId),
 * this adapter needs `userId`/`cartId` supplied out-of-band for the INSERT path:
 * the checkout flow always knows the buyer's account before calling the core's
 * `createOrder`, so it constructs this repository with that context. The
 * settlement/webhook flow never inserts a brand-new order (the order must already
 * exist from checkout), so it can construct this repository with no context at all —
 * `save()` on an existing row only ever UPDATEs the domain columns, never touching
 * userId/cartId.
 */
export class DrizzleOrderRepository implements OrderRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly insertContext?: { userId: string; cartId?: string | null },
  ) {}

  async findById(orderId: string): Promise<Order | null> {
    const row = await this.db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    return row ? rowToOrder(row) : null;
  }

  async findByPaymentAttemptId(paymentAttemptId: string): Promise<Order | null> {
    const attempt = await this.db.query.paymentAttempts.findFirst({
      where: eq(paymentAttempts.id, paymentAttemptId),
      columns: { orderId: true },
    });
    if (!attempt) return null;
    return this.findById(attempt.orderId);
  }

  async save(order: Order): Promise<void> {
    const existing = await this.db.query.orders.findFirst({
      where: eq(orders.id, order.id),
      columns: { id: true },
    });

    const domainColumns = {
      kind: order.kind,
      kindVersion: order.kindVersion,
      origin: order.origin,
      currency: order.currency,
      amountMinor: order.amountMinor,
      metadata: order.metadata,
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus,
      paidAt: order.paidAt,
      updatedAt: new Date(),
    };

    if (existing) {
      // Update path (e.g. webhook settlement, admin validate-transfer): deliberately
      // never touches userId/cartId — those belong to the checkout-time insert only.
      await this.db.update(orders).set(domainColumns).where(eq(orders.id, order.id));
      return;
    }

    if (!this.insertContext) {
      throw new Error(
        `DrizzleOrderRepository.save(): order ${order.id} does not exist and no ` +
          "insertContext (userId) was provided to construct it. This repository must be " +
          "instantiated with { userId, cartId } for any flow that creates new orders " +
          "(checkout). Settlement/webhook flows should only ever update existing orders.",
      );
    }

    await this.db.insert(orders).values({
      id: order.id,
      ...domainColumns,
      createdAt: order.createdAt,
      userId: this.insertContext.userId,
      cartId: this.insertContext.cartId ?? null,
    });
  }

  /**
   * Extra method beyond the core's `OrderRepository` port: reads back the app-owned
   * columns (userId, cartId) the core's `Order` object deliberately does not carry.
   * Used by the checkout/webhook services for things like granting credits or
   * sending the confirmation email in the buyer's account.
   */
  async findRowById(orderId: string): Promise<OrderRow | null> {
    const row = await this.db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    return row ?? null;
  }
}
