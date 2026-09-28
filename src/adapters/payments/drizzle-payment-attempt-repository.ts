import { and, desc, eq } from "drizzle-orm";
import { PaymentAttempt, type PaymentAttemptRepository } from "hexagonal-payments-core";
import type { DrizzleDb } from "../../db";
import { paymentAttempts } from "../../db/schema";

type AttemptRow = typeof paymentAttempts.$inferSelect;

function rowToAttempt(row: AttemptRow): PaymentAttempt {
  return PaymentAttempt.fromProps({
    id: row.id,
    orderId: row.orderId,
    provider: row.provider,
    status: row.status,
    providerRef: row.providerRef,
    createdAt: row.createdAt,
  });
}

/** Implements hexagonal-payments-core's `PaymentAttemptRepository` against `payments.payment_attempts`. */
export class DrizzlePaymentAttemptRepository implements PaymentAttemptRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findById(attemptId: string): Promise<PaymentAttempt | null> {
    const row = await this.db.query.paymentAttempts.findFirst({
      where: eq(paymentAttempts.id, attemptId),
    });
    return row ? rowToAttempt(row) : null;
  }

  async save(attempt: PaymentAttempt): Promise<void> {
    await this.db
      .insert(paymentAttempts)
      .values({
        id: attempt.id,
        orderId: attempt.orderId,
        provider: attempt.provider,
        status: attempt.status,
        providerRef: attempt.providerRef,
        createdAt: attempt.createdAt,
      })
      .onConflictDoUpdate({
        target: paymentAttempts.id,
        set: {
          status: attempt.status,
          providerRef: attempt.providerRef,
        },
      });
  }

  async findPaidAttempt(orderId: string): Promise<PaymentAttempt | null> {
    const row = await this.db.query.paymentAttempts.findFirst({
      where: and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, "paid")),
    });
    return row ? rowToAttempt(row) : null;
  }

  /**
   * Extra method beyond the core's port: resolves a provider's own reference
   * (e.g. ePayco's x_ref_payco, PayPal's order id) back to an attemptId — used by
   * each provider adapter's `parseWebhookEvent`.
   */
  async findByProviderRef(providerRef: string): Promise<PaymentAttempt | null> {
    const row = await this.db.query.paymentAttempts.findFirst({
      where: eq(paymentAttempts.providerRef, providerRef),
    });
    return row ? rowToAttempt(row) : null;
  }

  /**
   * Extra method beyond the core's port: resolves the most recent attempt
   * for an order. Needed because ePayco's webhook confirmation does NOT
   * echo back the session/checkout reference we stored as providerRef at
   * checkout time (confirmed against a real ePayco test transaction) — the
   * one field that reliably round-trips is x_id_invoice, which we set to
   * the order's own id at checkout. So the ePayco adapter resolves the
   * order by invoice/order id first, then needs this to find its attempt.
   */
  async findLatestByOrderId(orderId: string): Promise<PaymentAttempt | null> {
    const row = await this.db.query.paymentAttempts.findFirst({
      where: eq(paymentAttempts.orderId, orderId),
      orderBy: [desc(paymentAttempts.createdAt)],
    });
    return row ? rowToAttempt(row) : null;
  }
}
