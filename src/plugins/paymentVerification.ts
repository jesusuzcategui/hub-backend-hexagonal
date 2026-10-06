import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import cron from "node-cron";
import { createGuardedTick } from "./reminders";
import { runVerificationPass } from "../modules/payments/review-verification.service";

/**
 * On by default (the production image does not set NODE_ENV, so we cannot key "on" off it).
 * Off when PAYMENT_AUTOVERIFY_ENABLED=false, and ALWAYS off under NODE_ENV=test so a test boot can never call
 * ePayco. Local `pnpm dev` turns it off through the package.json script (a laptop with real ePayco keys must
 * never re-verify real transactions by accident).
 */
export function paymentVerificationEnabled(vars: { NODE_ENV?: string; PAYMENT_AUTOVERIFY_ENABLED?: string }): boolean {
  if (vars.NODE_ENV === "test") return false;
  return (vars.PAYMENT_AUTOVERIFY_ENABLED ?? "true").toLowerCase() !== "false";
}

// Every minute: the first retry is due 2 minutes after the flag, so a coarser tick would stretch the schedule.
// The pass is one indexed SELECT over a partial index that only holds orders waiting for a retry, and the
// atomic claim makes overlapping instances/ticks harmless.
const EVERY_MINUTE = "* * * * *";

async function paymentVerificationPlugin(fastify: FastifyInstance): Promise<void> {
  if (!paymentVerificationEnabled(process.env)) {
    fastify.log.info("payment-verification: disabled (NODE_ENV=test or PAYMENT_AUTOVERIFY_ENABLED=false)");
    return;
  }

  const tick = createGuardedTick(
    async () => {
      const summary = await runVerificationPass(fastify);
      if (summary.claimed > 0) {
        fastify.log.info(
          { claimed: summary.claimed, cleared: summary.cleared, mismatched: summary.mismatched, unavailable: summary.unavailable, expired: summary.expired },
          "payment-verification: pass finished",
        );
      }
    },
    fastify.log,
    "payment-verification",
  );

  fastify.addHook("onReady", async () => {
    const task = cron.schedule(EVERY_MINUTE, () => void tick(), { timezone: "UTC" });
    fastify.addHook("onClose", async () => {
      task.stop();
    });
    fastify.log.info("payment-verification: scheduled (every minute)");
  });
}

export default fp(paymentVerificationPlugin, { name: "payment-verification", dependencies: ["postgres", "mailer"] });
