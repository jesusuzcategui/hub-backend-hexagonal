import { randomUUID } from "crypto";
import type { CheckoutResult, CreateCheckoutInput, ManualSettlementProvider, ParsedPaymentEvent } from "hexagonal-payments-core";

/**
 * Manual bank-transfer "provider". There is no external gateway: the buyer uploads a
 * transfer proof, and an admin later confirms/rejects it against a bank statement.
 *
 * Design decision: `createCheckout` is a thin no-op that returns a synthetic
 * `providerRef` (a random UUID) instead of the checkout service skipping
 * `provider.createCheckout` entirely for this method. This keeps the checkout
 * service's control flow uniform across all three payment methods (always call
 * `provider.createCheckout` to obtain the attempt's `providerRef`, then branch only on
 * what happens *after* — redirect vs. accept-a-file-upload). The synthetic ref is what
 * `PaymentAttempt.withProviderRef()` gets set to at attempt-creation time; the checkout
 * service then overwrites it with the real WebDAV proof path once the file is uploaded.
 */
export class ManualTransferProvider implements ManualSettlementProvider {
  readonly name = "manual_transfer";

  async createCheckout(_input: CreateCheckoutInput): Promise<CheckoutResult> {
    return { providerRef: `manual:${randomUUID()}` };
  }

  /**
   * Called by the admin validate-transfer endpoint after a human decision (approve/reject
   * against a bank statement) — never by any webhook, since there is nothing to verify a
   * signature over.
   */
  buildSettlementEvent(input: {
    attemptId: string;
    confirmationId: string;
    status: string;
    amountMinor?: number;
    currency?: string;
  }): ParsedPaymentEvent {
    return {
      providerEventId: input.confirmationId,
      attemptId: input.attemptId,
      status: input.status,
      amountMinor: input.amountMinor,
      currency: input.currency,
      payloadHash: `manual:${input.attemptId}:${input.confirmationId}:${input.status}`,
    };
  }
}
