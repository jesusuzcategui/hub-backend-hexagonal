import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import cron from "node-cron";
import { and, eq, lte, sql } from "drizzle-orm";
import { accounts, refreshTokens } from "../db/schema";

// Runs daily at 03:00 UTC. Permanently deletes accounts that have been
// suspended for more than 60 days without reactivating.
async function purgeExpiredSuspensions(fastify: FastifyInstance): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  try {
    const stale = await fastify.drizzle
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.status, "suspended"),
          lte(accounts.suspendedAt, cutoff),
        ),
      );

    if (stale.length === 0) return;

    await fastify.drizzle.transaction(async (tx) => {
      for (const { id } of stale) {
        await tx.delete(refreshTokens).where(eq(refreshTokens.userId, id));
        await tx
          .update(accounts)
          .set({
            status: "deleted",
            isActive: false,
            deletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, id));
      }
    });

    fastify.log.info({ count: stale.length }, "autoPurge: deleted expired suspended accounts");
  } catch (err) {
    fastify.log.error({ err }, "autoPurge: failed to purge suspended accounts");
  }
}

async function autoPurgePlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("onReady", async () => {
    // Run immediately on startup to catch any missed purges
    await purgeExpiredSuspensions(fastify);

    // Then schedule daily at 03:00 UTC
    cron.schedule("0 3 * * *", () => purgeExpiredSuspensions(fastify), {
      timezone: "UTC",
    });

    fastify.log.info("autoPurge: scheduled (daily 03:00 UTC)");
  });
}

export default fp(autoPurgePlugin, { name: "autoPurge", dependencies: ["postgres"] });
