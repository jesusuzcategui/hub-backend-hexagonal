import { and, eq } from "drizzle-orm";
import { PaymentEvent, type PaymentEventStore } from "hexagonal-payments-core";
import type { DrizzleDb } from "../../db";
import { paymentEvents } from "../../db/schema";

/** Implements hexagonal-payments-core's `PaymentEventStore` against `payments.payment_events`. */
export class DrizzlePaymentEventStore implements PaymentEventStore {
  constructor(private readonly db: DrizzleDb) {}

  async hasProcessed(provider: string, providerEventId: string): Promise<boolean> {
    const row = await this.db.query.paymentEvents.findFirst({
      where: and(eq(paymentEvents.provider, provider), eq(paymentEvents.providerEventId, providerEventId)),
      columns: { id: true },
    });
    return !!row;
  }

  async record(event: PaymentEvent): Promise<void> {
    // Safe under races: (provider, provider_event_id) has a unique index, so a
    // concurrent duplicate webhook delivery is a no-op here, not a constraint error.
    await this.db
      .insert(paymentEvents)
      .values({
        id: event.id,
        provider: event.provider,
        providerEventId: event.providerEventId,
        orderId: event.orderId,
        payloadHash: event.payloadHash,
        processedAt: event.processedAt,
      })
      .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.providerEventId] });
  }
}
