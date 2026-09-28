import type { ProviderStatusMapper } from "hexagonal-payments-core";
import { EPAYCO_STATUS_MAP } from "../../adapters/payments/epayco-provider";
import { PAYPAL_STATUS_MAP } from "../../adapters/payments/paypal-provider";

const LEGAL_ATTEMPT_STATUSES = new Set([
  "created",
  "pending",
  "awaiting_verification",
  "paid",
  "failed",
  "cancelled",
  "expired",
  "refunded",
]);

function buildMapper(table: Record<string, string>, providerName: string): ProviderStatusMapper {
  return (rawStatus: string) => {
    const mapped = table[rawStatus];
    if (!mapped || !LEGAL_ATTEMPT_STATUSES.has(mapped)) {
      throw new Error(`${providerName}: unmapped raw status "${rawStatus}"`);
    }
    return mapped as ReturnType<ProviderStatusMapper>;
  };
}

export const epaycoStatusMapper: ProviderStatusMapper = buildMapper(EPAYCO_STATUS_MAP, "epayco");
export const paypalStatusMapper: ProviderStatusMapper = buildMapper(PAYPAL_STATUS_MAP, "paypal");

// Manual transfer: the admin decision ("approve"/"reject") is translated to a legal
// PaymentAttemptStatus BEFORE buildSettlementEvent is called (see payments.service.ts),
// so this mapper is an identity/validation pass-through.
export const manualTransferStatusMapper: ProviderStatusMapper = buildMapper(
  Object.fromEntries([...LEGAL_ATTEMPT_STATUSES].map((s) => [s, s])),
  "manual_transfer",
);
