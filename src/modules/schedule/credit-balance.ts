// Pure credit-balance rules. A student has ONE balance: the sum of what is left
// in all their non-expired credit blocks (scheduling.class_credits, one row per
// purchase/grant). No DB access here so the rules are unit-testable.
//
// Two different questions are answered about a block's `expiresAt`, on purpose:
//   1. "Can this credit be spent right now?"  -> isUsableBlock: an INSTANT comparison with `now`.
//   2. "Can this credit pay for a class on that date?" -> coversClassDate: a Bogota CALENDAR-DATE
//      comparison with the expiry day INCLUSIVE (a credit expiring any time on Dec 6 covers every
//      class on Dec 6, matching the campus "valid until <date>" label). A block with
//      `expiresAt = null` never limits the date.
// A class can be booked only if its block passes both.

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

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant in America/Bogota (fixed UTC-5, no DST). */
export function bogotaDateOf(instant: Date): string {
  return new Date(instant.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The block may pay for a class starting at `classStartsAt`: its Bogota calendar date is on or
 * before the expiry's Bogota calendar date (inclusive). Never-expiring blocks cover everything.
 * Says nothing about whether the block is usable right now (see isUsableBlock).
 */
export function coversClassDate(block: Pick<CreditBlockLike, "expiresAt">, classStartsAt: Date): boolean {
  if (block.expiresAt === null) return true;
  return bogotaDateOf(classStartsAt) <= bogotaDateOf(block.expiresAt);
}

export type PickForDateResult<T> =
  | { ok: true; block: T }
  | { ok: false; reason: "no_usable" }
  | { ok: false; reason: "after_credit_expiry"; latestCreditExpiry: Date };

/**
 * Block to charge for a class on `classStartsAt`: the earliest-expiring usable block with credit
 * left whose coverage includes the class date. `no_usable` = nothing is spendable now (the caller
 * keeps its NO_CREDITS / CREDITS_EXPIRED handling); `after_credit_expiry` = spendable blocks exist
 * but all of them expire before the class, with the latest of their expiries.
 */
export function pickCreditBlockForDate<T extends CreditBlockLike>(
  blocks: readonly T[],
  now: Date,
  classStartsAt: Date,
): PickForDateResult<T> {
  const usable = blocks.filter((b) => isUsableBlock(b, now)).sort(compareConsumptionOrder);
  if (usable.length === 0) return { ok: false, reason: "no_usable" };
  const covering = usable.find((b) => coversClassDate(b, classStartsAt));
  if (covering) return { ok: true, block: covering };
  // Every usable block has a non-null expiry here (a null one would have covered).
  const latest = Math.max(...usable.map((b) => b.expiresAt!.getTime()));
  return { ok: false, reason: "after_credit_expiry", latestCreditExpiry: new Date(latest) };
}

/**
 * Latest date a new class could still be booked: the latest expiry among usable blocks with credit
 * left. null when no block is usable or when any usable block never expires (no limit).
 */
export function latestUsableExpiry(blocks: readonly CreditBlockLike[], now: Date): Date | null {
  const usable = blocks.filter((b) => isUsableBlock(b, now));
  if (usable.length === 0 || usable.some((b) => b.expiresAt === null)) return null;
  return new Date(Math.max(...usable.map((b) => b.expiresAt!.getTime())));
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
