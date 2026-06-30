import fastifyCors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import Fastify, { FastifyInstance, FastifyError } from "fastify";
import postgresPlugin from "./plugins/postgres";
import redisPlugin from "./plugins/redis";
import jwtPlugin from "./plugins/jwt";
import requestLoggerHook from "./hooks/requestLogger";
import { authRoutes } from "./modules/auth/auth.routes";
import { usersRoutes } from "./modules/users/users.routes";
import { productsRoutes } from "./modules/products/products.routes";
import { checkoutRoutes } from "./modules/checkout/checkout.routes";
import { cartRoutes } from "./modules/cart/cart.routes";
import { paymentsRoutes } from "./modules/payments/payments.routes";
import { contentAccessRoutes } from "./modules/content-access/content-access.routes";
import { adminRoutes } from "./modules/admin/admin.routes";
import { scheduleRoutes } from "./modules/schedule/schedule.routes";
import { contactRoutes } from "./modules/contact/contact.routes";
import { portfolioRoutes } from "./modules/portfolio/portfolio.routes";
import caldavPlugin from "./plugins/caldav";
import mailerPlugin from "./plugins/mailer";
import autoPurgePlugin from "./plugins/autoPurge";
import { AppError } from "./lib/errors";
import { env } from "./config/env";

const ALLOWED_ORIGINS = [
  "http://localhost:4321",
  "http://localhost:8080",
  ...(env.app.publicUrl ? [env.app.publicUrl] : []),
  ...(env.mentoring.portfolioOrigin ? [env.mentoring.portfolioOrigin] : []),
];

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });

  app.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  app.register(fastifyCookie, { secret: env.server.stateSecret });
  app.register(postgresPlugin);
  app.register(redisPlugin);
  app.register(jwtPlugin);
  app.register(caldavPlugin);
  app.register(mailerPlugin);
  app.register(autoPurgePlugin);
  app.register(requestLoggerHook);

  app.register(authRoutes);
  app.register(usersRoutes);
  app.register(productsRoutes);
  app.register(checkoutRoutes);
  app.register(cartRoutes);
  app.register(paymentsRoutes);
  app.register(contentAccessRoutes);
  app.register(adminRoutes);
  app.register(scheduleRoutes);
  app.register(contactRoutes);
  app.register(portfolioRoutes);

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
