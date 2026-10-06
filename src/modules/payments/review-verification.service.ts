import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SystemClock } from "hexagonal-payments-core";
import { accounts, orders, paymentEvents } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { DrizzleOrderRepository } from "../../adapters/payments/drizzle-order-repository";
import { DrizzlePaymentAttemptRepository } from "../../adapters/payments/drizzle-payment-attempt-repository";
import { EpaycoProvider } from "../../adapters/payments/epayco-provider";
import { notifyAdminsOfReviewNeeded } from "./payments.service";
import { claimAdminAlert, recordReviewEvent, type ReviewEventKind } from "./review-store";
import {
  decideAfterContraste,
  isWindowExpired,
  parseVerifySchedule,
  planNextVerifyAt,
  type ContrasteData,
  type ContrasteOutcome,
  type ReviewDecision,
  type VerifySchedule,
} from "./review-verification";

const clock = new SystemClock();

/** Max orders handled per pass; the rest wait for the next tick (the partial index keeps the scan cheap). */
const PASS_BATCH_SIZE = 50;

/** The only thing the re-verification needs from ePayco; the real EpaycoProvider satisfies it. */
export interface ContrasteProvider {
  validateTransactionByReference(xRefPayco: string): Promise<ContrasteData>;
}

export interface VerificationOptions {
  now?: Date;
  dryRun?: boolean;
  provider?: ContrasteProvider;
  schedule?: VerifySchedule;
  /** Test seam: awaited after the due orders were selected and before any is claimed (forces claim races). */
  onDue?: (orderIds: string[]) => Promise<void>;
}

export interface VerificationSummary {
  dryRun: boolean;
  /** Orders that were due. */
  checked: number;
  /** Orders this pass won the atomic claim for (and therefore called ePayco about). */
  claimed: number;
  cleared: number;
  mismatched: number;
  unavailable: number;
  /** Orders whose window ended in this pass (admins alerted once). */
  expired: number;
  /** Only populated for dryRun. */
  wouldVerify?: string[];
}

function defaultProvider(fastify: FastifyInstance): ContrasteProvider {
  return new EpaycoProvider(new DrizzlePaymentAttemptRepository(fastify.drizzle));
}

/** The ePayco reference we were given at flag time; legacy rows fall back to the latest ePayco event of the order. */
async function resolveReference(fastify: FastifyInstance, row: { id: string; reviewProviderRef: string | null }): Promise<string | null> {
  if (row.reviewProviderRef) return row.reviewProviderRef;
  const [event] = await fastify.drizzle
    .select({ ref: paymentEvents.providerEventId })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.orderId, row.id), eq(paymentEvents.provider, "epayco")))
    .orderBy(desc(paymentEvents.processedAt))
    .limit(1);
  return event?.ref ?? null;
}

/**
 * Asks ePayco again, with its own reference. The webhook body is never consulted. Anything that is not data
 * (ePayco down, network error, unexpected throw, missing reference) is "unavailable": it never clears an order.
 */
async function fetchContraste(
  fastify: FastifyInstance,
  provider: ContrasteProvider,
  orderId: string,
  ref: string | null,
): Promise<ContrasteOutcome> {
  if (!ref) {
    fastify.log.warn({ orderId }, "payment re-verification: no ePayco reference stored for this order");
    return { kind: "unavailable" };
  }
  try {
    return { kind: "data", contraste: await provider.validateTransactionByReference(ref) };
  } catch (err) {
    fastify.log.warn({ orderId, errName: (err as Error)?.name }, "payment re-verification: ePayco contraste unavailable");
    return { kind: "unavailable" };
  }
}

async function clearReview(fastify: FastifyInstance, orderId: string, kind: ReviewEventKind, detail: Record<string, unknown>): Promise<void> {
  const orderRepo = new DrizzleOrderRepository(fastify.drizzle);
  const fresh = await orderRepo.findById(orderId);
  // Domain transition (needs_review -> delivered); skipped if someone else (admin) already cleared it.
  if (fresh && fresh.fulfillmentStatus === "needs_review") {
    await orderRepo.save(fresh.transitionFulfillment("delivered", clock.now()));
  }
  await fastify.drizzle.update(orders).set({ reviewReason: null, reviewNextVerifyAt: null }).where(eq(orders.id, orderId));
  await recordReviewEvent(fastify.drizzle, orderId, kind, detail);
  fastify.log.info({ orderId, kind }, "payment re-verification: order cleared from review");
}

async function alertAdminsOnce(fastify: FastifyInstance, orderId: string, now: Date, reason: string): Promise<void> {
  if (!(await claimAdminAlert(fastify.drizzle, orderId, now))) return;
  const row = await new DrizzleOrderRepository(fastify.drizzle).findRowById(orderId);
  if (!row) return;
  const [buyer] = await fastify.drizzle
    .select({ displayName: accounts.displayName, email: accounts.email })
    .from(accounts)
    .where(eq(accounts.id, row.userId))
    .limit(1);
  await notifyAdminsOfReviewNeeded(fastify, {
    orderId,
    buyerName: buyer?.displayName ?? "-",
    buyerEmail: buyer?.email ?? "-",
    amountMinor: row.amountMinor,
    currency: row.currency,
    reason,
  });
}

async function markMismatch(fastify: FastifyInstance, orderId: string, now: Date, detail: Record<string, unknown>): Promise<void> {
  // Never auto-cleared: leaves the cron scan (next = NULL), keeps needs_review, tells admins right away.
  await fastify.drizzle
    .update(orders)
    .set({ reviewReason: "contraste_mismatch", reviewNextVerifyAt: null })
    .where(eq(orders.id, orderId));
  await recordReviewEvent(fastify.drizzle, orderId, "mismatch", detail);
  fastify.log.error({ orderId }, "payment re-verification: ePayco data does not match the order");
  await alertAdminsOnce(
    fastify,
    orderId,
    now,
    "Re-verificación con ePayco: los datos de ePayco NO coinciden con la orden (factura, monto o moneda). Se mantiene en revisión y no se limpia automáticamente; los créditos ya habían sido otorgados. Revisá la transacción en el dashboard de ePayco.",
  );
}

/**
 * One pass of the automatic re-verification. Safe to run on several instances and on overlapping ticks: every
 * order is CLAIMED with an atomic UPDATE (attempts + 1, next attempt pushed into the future) before ePayco is
 * called, so only one runner ever processes a given attempt.
 */
export async function runVerificationPass(fastify: FastifyInstance, opts: VerificationOptions = {}): Promise<VerificationSummary> {
  const now = opts.now ?? new Date();
  const schedule = opts.schedule ?? parseVerifySchedule(process.env);
  const db = fastify.drizzle;
  const summary: VerificationSummary = { dryRun: Boolean(opts.dryRun), checked: 0, claimed: 0, cleared: 0, mismatched: 0, unavailable: 0, expired: 0 };

  const due = await db
    .select({ id: orders.id, flaggedAt: orders.reviewFlaggedAt, attempts: orders.reviewVerifyAttempts })
    .from(orders)
    .where(
      and(
        eq(orders.reviewReason, "contraste_unavailable"),
        eq(orders.fulfillmentStatus, "needs_review"),
        lte(orders.reviewNextVerifyAt, now),
      ),
    )
    .orderBy(asc(orders.reviewNextVerifyAt))
    .limit(PASS_BATCH_SIZE);
  summary.checked = due.length;

  if (opts.dryRun) {
    summary.wouldVerify = due.map((d) => d.id);
    return summary;
  }
  if (due.length === 0) return summary;

  const provider = opts.provider ?? defaultProvider(fastify);
  await opts.onDue?.(due.map((d) => d.id));

  for (const candidate of due) {
    const nextAt = planNextVerifyAt(candidate.flaggedAt, candidate.attempts + 1, now, schedule);
    // The claim: only the runner whose UPDATE still sees review_next_verify_at <= now gets the row back.
    const [claimed] = await db
      .update(orders)
      .set({
        reviewNextVerifyAt: nextAt,
        reviewVerifyAttempts: sql`${orders.reviewVerifyAttempts} + 1`,
      })
      .where(
        and(
          eq(orders.id, candidate.id),
          eq(orders.reviewReason, "contraste_unavailable"),
          eq(orders.fulfillmentStatus, "needs_review"),
          lte(orders.reviewNextVerifyAt, now),
        ),
      )
      .returning({
        id: orders.id,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        flaggedAt: orders.reviewFlaggedAt,
        attempts: orders.reviewVerifyAttempts,
        providerRef: orders.reviewProviderRef,
      });
    if (!claimed) continue;
    summary.claimed++;

    try {
      const ref = await resolveReference(fastify, { id: claimed.id, reviewProviderRef: claimed.providerRef });
      const outcome = await fetchContraste(fastify, provider, claimed.id, ref);
      const decision: ReviewDecision = decideAfterContraste(outcome, claimed);

      if (decision === "clear") {
        await clearReview(fastify, claimed.id, "auto_cleared", { attempt: claimed.attempts });
        summary.cleared++;
      } else if (decision === "mismatch") {
        await markMismatch(fastify, claimed.id, now, { attempt: claimed.attempts, source: "cron" });
        summary.mismatched++;
      } else {
        await recordReviewEvent(db, claimed.id, "verify_unavailable", { attempt: claimed.attempts });
        summary.unavailable++;
        if (isWindowExpired(claimed.flaggedAt, now, schedule)) {
          await db.update(orders).set({ reviewNextVerifyAt: null }).where(eq(orders.id, claimed.id));
          await recordReviewEvent(db, claimed.id, "window_expired", { attempts: claimed.attempts, windowMin: schedule.windowMin });
          summary.expired++;
          await alertAdminsOnce(
            fastify,
            claimed.id,
            now,
            `ePayco no pudo confirmar la transacción tras ${schedule.windowMin} minutos de reintentos automáticos (${claimed.attempts} intentos). Se mantiene en revisión; el estudiante ya recibió sus créditos y el correo de confirmación. Verificá el pago en el dashboard de ePayco y usá "Re-verificar" o "Marcar como verificado".`,
          );
        }
      }
    } catch (err) {
      // The claim already moved the next attempt into the future, so a failure here only delays this order.
      fastify.log.error({ orderId: claimed.id, errName: (err as Error)?.name }, "payment re-verification: processing failed");
    }
  }
  return summary;
}

export type ReverifyStatus = "cleared" | "unavailable" | "mismatch";

/** Admin "Re-verify now": ONE contraste attempt, same decision code as the cron. */
export async function reverifyOrder(
  fastify: FastifyInstance,
  orderId: string,
  opts: { provider?: ContrasteProvider; now?: Date } = {},
): Promise<{ status: ReverifyStatus }> {
  const row = await new DrizzleOrderRepository(fastify.drizzle).findRowById(orderId);
  if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  if (row.status !== "paid") throw new AppError(409, "ORDER_NOT_PAID", "Order is not paid yet");
  if (row.fulfillmentStatus !== "needs_review") throw new AppError(409, "NOT_NEEDS_REVIEW", "Order is not pending manual review");
  // A failed credit/content grant is a real problem that ePayco's data cannot fix.
  if (row.reviewReason === "fulfillment_failed") {
    throw new AppError(409, "REVIEW_NOT_VERIFIABLE", "This review is about a failed grant, not about ePayco verification");
  }

  const now = opts.now ?? new Date();
  const provider = opts.provider ?? defaultProvider(fastify);
  const ref = await resolveReference(fastify, { id: row.id, reviewProviderRef: row.reviewProviderRef });
  const outcome = await fetchContraste(fastify, provider, row.id, ref);
  const decision = decideAfterContraste(outcome, row);

  if (decision === "clear") {
    await clearReview(fastify, row.id, "reverify_cleared", { source: "admin" });
    return { status: "cleared" };
  }
  if (decision === "mismatch") {
    await markMismatch(fastify, row.id, now, { source: "admin" });
    return { status: "mismatch" };
  }
  await recordReviewEvent(fastify.drizzle, row.id, "verify_unavailable", { source: "admin" });
  return { status: "unavailable" };
}
