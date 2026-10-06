import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../../db";
import { orders, orderReviewEvents } from "../../db/schema";
import { planNextVerifyAt, type ReviewReason, type VerifySchedule, DEFAULT_VERIFY_SCHEDULE } from "./review-verification";

export type ReviewEventKind =
  | "flagged"
  | "verify_unavailable"
  | "auto_cleared"
  | "reverify_cleared"
  | "manual_cleared"
  | "mismatch"
  | "window_expired";

/** Append-only audit trail of what happened to an order while it was under review. */
export async function recordReviewEvent(
  db: DrizzleDb,
  orderId: string,
  kind: ReviewEventKind,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(orderReviewEvents).values({ orderId, kind, detail });
}

/**
 * Persists WHY an order sits in needs_review. For `contraste_unavailable` it also schedules the first automatic
 * re-verification; the other reasons are never picked up by the cron (review_next_verify_at stays NULL).
 * `alerted` records that admins were already told, which is what keeps the one-time alerts restart-safe.
 */
export async function flagOrderForReview(
  db: DrizzleDb,
  input: { orderId: string; reason: ReviewReason; providerRef?: string | null; now: Date; alerted?: boolean; schedule?: VerifySchedule },
): Promise<void> {
  const schedule = input.schedule ?? DEFAULT_VERIFY_SCHEDULE;
  const nextVerifyAt = input.reason === "contraste_unavailable" ? planNextVerifyAt(input.now, 0, input.now, schedule) : null;
  await db
    .update(orders)
    .set({
      reviewReason: input.reason,
      reviewFlaggedAt: input.now,
      reviewVerifyAttempts: 0,
      reviewNextVerifyAt: nextVerifyAt,
      reviewProviderRef: input.providerRef ?? null,
      reviewAlertedAt: input.alerted ? input.now : null,
    })
    .where(eq(orders.id, input.orderId));
  await recordReviewEvent(db, input.orderId, "flagged", { reason: input.reason });
}

/**
 * Claims the right to send the one-time admin alert for an order. Returns true for exactly one caller: the UPDATE
 * only matches while review_alerted_at is still NULL, so a restart or a second instance can never resend it.
 */
export async function claimAdminAlert(db: DrizzleDb, orderId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(orders)
    .set({ reviewAlertedAt: now })
    .where(and(eq(orders.id, orderId), isNull(orders.reviewAlertedAt)))
    .returning({ id: orders.id });
  return rows.length === 1;
}
