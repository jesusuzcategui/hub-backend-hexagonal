import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { requestLogs } from "../db/schema";

async function requestLoggerHook(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("onResponse", async (request, reply) => {
    const userId =
      (request as unknown as { user?: { sub?: string } }).user?.sub ?? null;

    try {
      await fastify.drizzle.insert(requestLogs).values({
        userId,
        method: request.method,
        path: (request.routeOptions as { url?: string } | undefined)?.url ?? request.url.split("?")[0],
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        ipAddress: request.ip ?? null,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
    } catch {
      // non-critical — never fail the response
    }
  });
}

export default fp(requestLoggerHook, { name: "requestLogger", dependencies: ["postgres"] });
