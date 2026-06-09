import fastifyCookie from "@fastify/cookie";
import Fastify, { FastifyInstance, FastifyError } from "fastify";
import postgresPlugin from "./plugins/postgres";
import redisPlugin from "./plugins/redis";
import jwtPlugin from "./plugins/jwt";
import { authRoutes } from "./modules/auth/auth.routes";
import { usersRoutes } from "./modules/users/users.routes";
import { productsRoutes } from "./modules/products/products.routes";
import { checkoutRoutes } from "./modules/checkout/checkout.routes";
import { AppError } from "./lib/errors";
import { env } from "./config/env";

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });

  app.register(fastifyCookie, { secret: env.server.stateSecret });
  app.register(postgresPlugin);
  app.register(redisPlugin);
  app.register(jwtPlugin);

  app.register(authRoutes);
  app.register(usersRoutes);
  app.register(productsRoutes);
  app.register(checkoutRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  app.setErrorHandler((error: FastifyError | AppError, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    // Fastify validation errors (JSON schema) — we use Zod manually, but just in case
    if (error.statusCode && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: "BAD_REQUEST", message: error.message },
      });
      return;
    }

    app.log.error(error);
    reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });

  return app;
};
