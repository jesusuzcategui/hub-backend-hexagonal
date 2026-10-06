import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import cron from "node-cron";
import { runReminderPass } from "../modules/schedule/reminders.service";

/**
 * On by default (the production image does not set NODE_ENV, so we cannot key "on" off it).
 * Off when REMINDERS_ENABLED=false, and ALWAYS off under NODE_ENV=test so a test boot can never
 * email anybody. Local `pnpm dev` turns it off through the package.json script.
 */
export function remindersEnabled(vars: { NODE_ENV?: string; REMINDERS_ENABLED?: string }): boolean {
  if (vars.NODE_ENV === "test") return false;
  return (vars.REMINDERS_ENABLED ?? "true").toLowerCase() !== "false";
}

interface TickLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/** Wraps a run so a tick is skipped while the previous one is still running (no overlap). */
export function createGuardedTick(run: () => Promise<void>, log: TickLogger, label = "reminders"): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      log.warn({}, `${label}: previous run still in progress, skipping tick`);
      return;
    }
    running = true;
    try {
      await run();
    } catch (err) {
      log.error({ errName: (err as Error)?.name }, `${label}: run failed`);
    } finally {
      running = false;
    }
  };
}

// Every minute. The 1h reminder is the time-sensitive one and a 5-minute tick could deliver it up
// to 5 minutes late (6 of the 60 minutes of notice). The pass is one indexed SELECT over confirmed
// bookings in the next 24h (idx_bookings_reminder_scan), so 1/min is cheap, and the atomic claim
// makes overlapping instances/ticks harmless.
const EVERY_MINUTE = "* * * * *";

async function remindersPlugin(fastify: FastifyInstance): Promise<void> {
  if (!remindersEnabled(process.env)) {
    fastify.log.info("reminders: disabled (NODE_ENV=test or REMINDERS_ENABLED=false)");
    return;
  }

  const tick = createGuardedTick(async () => {
    const summary = await runReminderPass(fastify);
    if (summary.sent24h + summary.sent1h + summary.failed > 0) {
      fastify.log.info(
        { sent24h: summary.sent24h, sent1h: summary.sent1h, failed: summary.failed },
        "reminders: pass finished",
      );
    }
  }, fastify.log);

  fastify.addHook("onReady", async () => {
    const task = cron.schedule(EVERY_MINUTE, () => void tick(), { timezone: "UTC" });
    fastify.addHook("onClose", async () => {
      task.stop();
    });
    fastify.log.info("reminders: scheduled (every minute)");
  });
}

export default fp(remindersPlugin, { name: "reminders", dependencies: ["postgres", "mailer"] });
