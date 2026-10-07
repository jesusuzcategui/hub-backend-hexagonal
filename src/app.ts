import fastifyCors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import Fastify, { FastifyInstance, FastifyError, FastifyRequest } from "fastify";
import postgresPlugin from "./plugins/postgres";
import redisPlugin from "./plugins/redis";
import jwtPlugin from "./plugins/jwt";
import requestLoggerHook from "./hooks/requestLogger";
import { authRoutes } from "./modules/auth/auth.routes";
import { usersRoutes } from "./modules/users/users.routes";
import { productsRoutes } from "./modules/products/products.routes";
import { cartRoutes } from "./modules/cart/cart.routes";
import { contentAccessRoutes } from "./modules/content-access/content-access.routes";
import { adminRoutes } from "./modules/admin/admin.routes";
import { scheduleRoutes } from "./modules/schedule/schedule.routes";
import { contactRoutes } from "./modules/contact/contact.routes";
import { portfolioRoutes } from "./modules/portfolio/portfolio.routes";
import { paymentsRoutes } from "./modules/payments/payments.routes";
import { classNotesRoutes } from "./modules/class-notes/class-notes.routes";
import caldavPlugin from "./plugins/caldav";
import mailerPlugin from "./plugins/mailer";
import webdavPlugin from "./plugins/webdav";
import autoPurgePlugin from "./plugins/autoPurge";
import remindersPlugin from "./plugins/reminders";
import paymentVerificationPlugin from "./plugins/paymentVerification";
import calendarSyncPlugin from "./plugins/calendarSync";
import { AppError, appErrorBody } from "./lib/errors";
import { env } from "./config/env";

// Routes whose handlers need the exact bytes that were signed by the provider
// (ePayco's HMAC-style signature, PayPal's transmission signature) — no other route in
// this repo needs raw-body access, so this is scoped to exactly these two paths rather
// than switching JSON parsing globally.
const RAW_BODY_ROUTES = new Set(["/webhooks/epayco", "/webhooks/paypal"]);

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const ALLOWED_ORIGINS = [
  "http://localhost:4321",
  "http://localhost:8080",
  "http://localhost:3402", // jesusuzcategui-campus (Nuxt) dev server
  ...(env.app.publicUrl ? [env.app.publicUrl] : []),
  ...(env.mentoring.portfolioOrigin ? [env.mentoring.portfolioOrigin] : []),
  // Campus's own origin was never added here — it only ever worked in dev
  // because localhost:3402 is hardcoded above. Any deploy (staging, prod)
  // needs this or Campus can't log in cross-origin at all (CORS silently
  // blocks the request, surfaces to the user as a generic fetch error).
  ...(env.campus.origin ? [env.campus.origin] : []),
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
  app.register(fastifyMultipart);
  app.register(postgresPlugin);
  app.register(redisPlugin);
  app.register(jwtPlugin);
  app.register(caldavPlugin);
  app.register(mailerPlugin);
  app.register(webdavPlugin);
  app.register(autoPurgePlugin);
  app.register(remindersPlugin);
  app.register(paymentVerificationPlugin);
  app.register(calendarSyncPlugin);
  app.register(requestLoggerHook);

  // Capture the raw bytes for the two webhook routes (ePayco's signature and PayPal's
  // transmission signature must be verified over the exact bytes received, before any
  // JSON parsing/reformatting). Every other route keeps normal JSON parsing.
  const rawBodyAwareJsonParser = (request: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
    if (RAW_BODY_ROUTES.has(request.url.split("?")[0])) {
      request.rawBody = body;
    }
    const text = body.toString("utf8");
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  };
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, rawBodyAwareJsonParser);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (request: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      if (RAW_BODY_ROUTES.has(request.url.split("?")[0])) {
        request.rawBody = body;
      }
      const parsed: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body.toString("utf8")).entries()) {
        parsed[key] = value;
      }
      done(null, parsed);
    },
  );

  app.register(authRoutes);
  app.register(usersRoutes);
  app.register(productsRoutes);
  app.register(cartRoutes);
  app.register(contentAccessRoutes);
  app.register(adminRoutes);
  app.register(scheduleRoutes);
  app.register(contactRoutes);
  app.register(portfolioRoutes);
  app.register(paymentsRoutes);
  app.register(classNotesRoutes);

  // `redis` reports whether the shared Redis is active ("connected"), unavailable and degraded to in-memory
  // ("degraded"), or not configured ("disabled"). The status itself stays "ok": Redis is never required.
  app.get("/health", async () => ({ status: "ok", ...app.cacheInfo() }));

  app.setErrorHandler((error: FastifyError | AppError, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send(appErrorBody(error));
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
