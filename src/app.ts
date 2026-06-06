import fastifyCookie from "@fastify/cookie";
import Fastify, { FastifyInstance } from "fastify";
import postgresPlugin from "./plugins/postgres";
import redisPlugin from "./plugins/redis";

export const buildApp = (): FastifyInstance => {
  const app = Fastify({
    logger: true,
  });

  app.register(fastifyCookie);
  app.register(postgresPlugin);
  app.register(redisPlugin);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
};
