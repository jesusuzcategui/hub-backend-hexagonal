import fastifyCookie from "@fastify/cookie";
import Fastify, { FastifyInstance } from "fastify";

export const buildApp = (): FastifyInstance => {
  const app = Fastify({
    logger: true,
  });

  app.register(fastifyCookie);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
};
