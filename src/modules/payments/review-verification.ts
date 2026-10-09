// Pure decision logic for the automatic re-verification of paid orders that were flagged
// `needs_review` only because ePayco's server-to-server "contraste" endpoint was unavailable.
// No I/O here: everything is unit-testable and shared by the webhook, the cron pass and the
// admin "reverify" endpoint so they can never disagree about what counts as a match.

const MIN_MS = 60_000;

export type ReviewReason = "contraste_unavailable" | "fulfillment_failed" | "contraste_mismatch";

export interface VerifySchedule {
  /** Minutes after the flag at which each retry is due, strictly increasing. */
  offsetsMin: readonly number[];
  /** Minutes after the flag at which we give up, alert the admins once and stop retrying. */
  windowMin: number;
}

/** First retry 2 min after the flag, then 5, 10, 20 and 40 min after it (offsets from the flag, not gaps). */
export const REVIEW_VERIFY_OFFSETS_MIN: readonly number[] = [2, 5, 10, 20, 40];
/** After 60 min of ePayco being unavailable: one final attempt, then alert admins once. */
export const REVIEW_WINDOW_MIN = 60;
/** Never schedule an attempt sooner than this from "now" (also the in-flight lock of a claimed order). */
export const REVIEW_MIN_RETRY_GAP_MS = MIN_MS;

export const DEFAULT_VERIFY_SCHEDULE: VerifySchedule = {
  offsetsMin: REVIEW_VERIFY_OFFSETS_MIN,
  windowMin: REVIEW_WINDOW_MIN,
};

function isPositiveInt(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n) && n > 0;
}

/**
 * Reads PAYMENT_AUTOVERIFY_SCHEDULE_MINUTES ("2,5,10,20,40") and PAYMENT_AUTOVERIFY_WINDOW_MINUTES ("60").
 * Anything invalid falls back to the defaults; offsets at or past the window are dropped (the window end
 * is itself the last attempt).
 */
export function parseVerifySchedule(vars: {
  PAYMENT_AUTOVERIFY_SCHEDULE_MINUTES?: string;
  PAYMENT_AUTOVERIFY_WINDOW_MINUTES?: string;
}): VerifySchedule {
  const windowRaw = Number(vars.PAYMENT_AUTOVERIFY_WINDOW_MINUTES);
  const windowMin = vars.PAYMENT_AUTOVERIFY_WINDOW_MINUTES !== undefined && isPositiveInt(windowRaw) ? windowRaw : REVIEW_WINDOW_MIN;

  let offsets: number[] = [...REVIEW_VERIFY_OFFSETS_MIN];
  const raw = vars.PAYMENT_AUTOVERIFY_SCHEDULE_MINUTES;
  if (raw !== undefined) {
    const parsed = raw.split(",").map((s) => Number(s.trim()));
    const valid = parsed.length > 0 && parsed.every(isPositiveInt) && parsed.every((n, i) => i === 0 || n > parsed[i - 1]);
    if (valid) offsets = parsed;
  }
  return { offsetsMin: offsets.filter((m) => m < windowMin), windowMin };
}

/**
 * Offset (ms) from the flag time at which the next attempt is due, given how many attempts were already
 * made. Once the schedule is exhausted the next (final) attempt is due at the end of the window.
 */
export function nextVerifyDelayMs(attemptsDone: number, schedule: VerifySchedule = DEFAULT_VERIFY_SCHEDULE): number {
  const i = Math.max(0, Math.floor(attemptsDone));
  const minutes = i < schedule.offsetsMin.length ? schedule.offsetsMin[i] : schedule.windowMin;
  return minutes * MIN_MS;
}

/** True once `now` is at or past the end of the window. A missing flag time counts as expired. */
export function isWindowExpired(
  flaggedAt: Date | null | undefined,
  now: Date,
  schedule: VerifySchedule = DEFAULT_VERIFY_SCHEDULE,
): boolean {
  if (!flaggedAt) return true;
  return now.getTime() >= flaggedAt.getTime() + schedule.windowMin * MIN_MS;
}

/** When the attempt after `attemptsDone` completed attempts is due; never sooner than a minute from now. */
export function planNextVerifyAt(
  flaggedAt: Date | null | undefined,
  attemptsDone: number,
  now: Date,
  schedule: VerifySchedule = DEFAULT_VERIFY_SCHEDULE,
): Date {
  const floor = now.getTime() + REVIEW_MIN_RETRY_GAP_MS;
  if (!flaggedAt) return new Date(floor);
  const due = flaggedAt.getTime() + nextVerifyDelayMs(attemptsDone, schedule);
  return new Date(Math.max(due, floor));
}

export interface ContrasteData {
  invoice: string;
  amountMinor: number;
  currency: string;
  /**
   * ePayco's own verdict: true approved (x_cod_response 1), false rejected/failed, null still pending.
   * The webhook's x_transaction_state is NOT signed, so it never decides.
   */
  approved: boolean | null;
}

export interface OrderForContraste {
  id: string;
  amountMinor: number;
  currency: string;
}

/**
 * The single definition of "ePayco's own data matches the order". The invoice is always required; amount,
 * currency and ePayco's own approval are asserted only when the webhook claims the payment was approved (a
 * forged non-approved webhook moves no money, and being strict there breaks legitimate decline notifications).
 * A paid order is by definition approved.
 */
export function contrasteMatchesOrder(
  contraste: ContrasteData,
  order: OrderForContraste,
  opts: { isApproved: boolean },
): boolean {
  const invoiceMatches = contraste.invoice === order.id;
  if (!opts.isApproved) return invoiceMatches;
  return (
    invoiceMatches &&
    contraste.approved === true &&
    contraste.amountMinor === order.amountMinor &&
    contraste.currency === order.currency.toUpperCase()
  );
}

export type ContrasteOutcome = { kind: "data"; contraste: ContrasteData } | { kind: "unavailable" };
export type ReviewDecision = "clear" | "mismatch" | "unavailable";

/**
 * Decision for an already-paid order being re-verified: the order is paid, so amount/currency and ePayco's
 * approval are required. A transaction ePayco still reports as pending is not a mismatch yet: retry later.
 */
export function decideAfterContraste(result: ContrasteOutcome, order: OrderForContraste): ReviewDecision {
  if (result.kind === "unavailable") return "unavailable";
  if (result.contraste.approved === null) return "unavailable";
  return contrasteMatchesOrder(result.contraste, order, { isApproved: true }) ? "clear" : "mismatch";
}

type Fulfillment = "pending" | "delivered" | "needs_review";

/**
 * What a STUDENT is shown. An order held only because ePayco's contraste was unavailable has already granted
 * credits and sent the success email, so it reads as delivered. Every other reason (a failed grant, a mismatch,
 * or an unknown legacy reason) keeps `needs_review` so we never hide a real problem.
 */
export function studentFacingFulfillment(order: {
  fulfillmentStatus: Fulfillment;
  reviewReason: string | null | undefined;
}): Fulfillment {
  if (order.fulfillmentStatus === "needs_review" && order.reviewReason === "contraste_unavailable") return "delivered";
  return order.fulfillmentStatus;
}
