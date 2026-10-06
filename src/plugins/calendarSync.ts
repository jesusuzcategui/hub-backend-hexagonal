import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import cron from "node-cron";
import { createGuardedTick } from "./reminders";
import { calendarSyncEnabled } from "../modules/calendar-sync/config";
import { runCalDavSync } from "../modules/calendar-sync/calendar-sync.service";

export { calendarSyncEnabled };

// Every 5 minutes. This is also the staleness bound of the whole feature: a block added in Nextcloud reaches the
// platform within 5 minutes, and a booking made inside that window is not re-checked against the live calendar
// (at worst the student gets a late "Slot is blocked" or the admin sees it under /admin/calendar-sync/conflicts).
const EVERY_FIVE_MINUTES = "*/5 * * * *";

async function calendarSyncPlugin(fastify: FastifyInstance): Promise<void> {
  if (!calendarSyncEnabled(process.env)) {
    fastify.log.info("calendar-sync: disabled (NODE_ENV=test or CALDAV_SYNC_ENABLED=false)");
    return;
  }

  // The pass logs its own outcome (counters only). The guard just keeps ticks from overlapping.
  const tick = createGuardedTick(
    async () => {
      await runCalDavSync(fastify, { trigger: "cron" });
    },
    fastify.log,
    "calendar-sync",
  );

  fastify.addHook("onReady", async () => {
    const task = cron.schedule(EVERY_FIVE_MINUTES, () => void tick(), { timezone: "UTC" });
    fastify.addHook("onClose", async () => {
      task.stop();
    });
    fastify.log.info("calendar-sync: scheduled (every 5 minutes, first pass now)");
    void tick(); // first pass right away; never blocks the server from becoming ready
  });
}

export default fp(calendarSyncPlugin, { name: "calendar-sync", dependencies: ["postgres"] });
