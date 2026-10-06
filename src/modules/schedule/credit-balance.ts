// Pure credit-balance rules. A student has ONE balance: the sum of what is left
// in all their non-expired credit blocks (scheduling.class_credits, one row per
// purchase/grant). No DB access here so the rules are unit-testable.

export const DEFAULT_CREDIT_VALIDITY_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreditBlockLike {
  totalCredits: number;
  usedCredits: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface SummarizableBlock extends CreditBlockLike {
  creditId: string;
  productName: string;
}

export interface BalanceBlock {
  creditId: string;
  productName: string;
  totalCredits: number;
  usedCredits: number;
  remaining: number;
  expiresAt: Date | null;
}

export interface BalanceSummary {
  balance: number;
  nextExpiry: Date | null;
  blocks: BalanceBlock[];
}

/** Expiry of a block granted at `grantDate`; invalid or missing validity falls back to 60 days. */
export function computeCreditExpiry(grantDate: Date, validityDays: number | undefined): Date {
  const days =
    typeof validityDays === "number" && Number.isInteger(validityDays) && validityDays > 0
      ? validityDays
      : DEFAULT_CREDIT_VALIDITY_DAYS;
  return new Date(grantDate.getTime() + days * DAY_MS);
}

/** Usable at `now`: credits left and not expired (expiresAt <= now counts as expired). */
export function isUsableBlock(block: CreditBlockLike, now: Date): boolean {
  if (block.usedCredits >= block.totalCredits) return false;
  return block.expiresAt === null || block.expiresAt.getTime() > now.getTime();
}

function compareConsumptionOrder(a: CreditBlockLike, b: CreditBlockLike): number {
  const ax = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY;
  const bx = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY;
  if (ax !== bx) return ax < bx ? -1 : 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/** Block to charge next: expires first (never-expiring last), then oldest purchase. */
export function pickCreditBlock<T extends CreditBlockLike>(blocks: readonly T[], now: Date): T | null {
  const usable = blocks.filter((b) => isUsableBlock(b, now)).sort(compareConsumptionOrder);
  return usable[0] ?? null;
}

export function summarizeBalance(blocks: readonly SummarizableBlock[], now: Date): BalanceSummary {
  const usable = blocks.filter((b) => isUsableBlock(b, now)).sort(compareConsumptionOrder);
  const out: BalanceBlock[] = usable.map((b) => ({
    creditId: b.creditId,
    productName: b.productName,
    totalCredits: b.totalCredits,
    usedCredits: b.usedCredits,
    remaining: b.totalCredits - b.usedCredits,
    expiresAt: b.expiresAt,
  }));
  return {
    balance: out.reduce((sum, b) => sum + b.remaining, 0),
    nextExpiry: out.find((b) => b.expiresAt !== null)?.expiresAt ?? null,
    blocks: out,
  };
}

function readValidityDays(metadata: unknown): number | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>).validityDays;
  const n = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  return typeof n === "number" ? n : undefined;
}

/**
 * Expiry for a new credit block: an explicit date (manual admin override) wins,
 * otherwise the product's `metadata.validityDays`, otherwise 60 days.
 */
export function resolveGrantExpiry(grantDate: Date, productMetadata: unknown, explicitExpiresAt?: Date | null): Date {
  if (explicitExpiresAt) return explicitExpiresAt;
  return computeCreditExpiry(grantDate, readValidityDays(productMetadata));
}
