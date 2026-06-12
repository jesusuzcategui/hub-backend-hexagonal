import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  STATE_SECRET: z.string().min(32),
  ALLOWED_REDIRECT_HOSTS: z.string().default(""),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_EXPIRY_SECONDS: z.coerce.number().int().positive().default(2592000),

  COOKIE_SECURE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  COOKIE_DOMAIN: z.string().optional(),

  APP_PUBLIC_URL: z.string().url().optional(),
  MP_ACCESS_TOKEN: z.string().min(1),
  MP_WEBHOOK_SECRET: z.string().min(32),
  MP_SUCCESS_URL: z.string().url(),
  MP_FAILURE_URL: z.string().url(),
  MP_PENDING_URL: z.string().url(),

  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_SUCCESS_URL: z.string().url(),
  PAYPAL_CANCEL_URL: z.string().url(),

  STRAPI_URL: z.string().url(),
  STRAPI_TOKEN: z.string().min(1),
  STRAPI_WEBHOOK_SECRET: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

  CALDAV_URL: z.string().url(),
  CALDAV_USERNAME: z.string().min(1),
  CALDAV_PASSWORD: z.string().min(1),

  JITSI_BASE_URL: z.string().url().default("https://talk.jesusuzcategui.com"),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.string().default("false").transform((v) => v === "true"),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM: z.string().min(1).default("hello@vanjex.dev"),
  SMTP_FROM_NAME: z.string().min(1).default("Jesus Uzcategui"),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const _env = parsed.data;

const allowedHosts = _env.ALLOWED_REDIRECT_HOSTS.split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export const env = {
  server: {
    port: _env.PORT,
    stateSecret: _env.STATE_SECRET,
    allowedRedirectHosts: new Set(allowedHosts),
  },
  database: {
    url: _env.DATABASE_URL,
  },
  cache: {
    url: _env.REDIS_URL,
  },
  jwt: {
    accessSecret: _env.JWT_ACCESS_SECRET,
    accessExpirySeconds: _env.JWT_ACCESS_EXPIRY_SECONDS,
    refreshExpirySeconds: _env.JWT_REFRESH_EXPIRY_SECONDS,
  },
  cookie: {
    secure: _env.COOKIE_SECURE,
    domain: _env.COOKIE_DOMAIN,
  },
  app: {
    publicUrl: _env.APP_PUBLIC_URL,
  },
  mercadopago: {
    accessToken: _env.MP_ACCESS_TOKEN,
    webhookSecret: _env.MP_WEBHOOK_SECRET,
    successUrl: _env.MP_SUCCESS_URL,
    failureUrl: _env.MP_FAILURE_URL,
    pendingUrl: _env.MP_PENDING_URL,
  },
  paypal: {
    clientId: _env.PAYPAL_CLIENT_ID,
    clientSecret: _env.PAYPAL_CLIENT_SECRET,
    mode: _env.PAYPAL_MODE,
    webhookId: _env.PAYPAL_WEBHOOK_ID,
    successUrl: _env.PAYPAL_SUCCESS_URL,
    cancelUrl: _env.PAYPAL_CANCEL_URL,
  },
  strapi: {
    url: _env.STRAPI_URL,
    token: _env.STRAPI_TOKEN,
    webhookSecret: _env.STRAPI_WEBHOOK_SECRET,
  },
  caldav: {
    url: _env.CALDAV_URL,
    username: _env.CALDAV_USERNAME,
    password: _env.CALDAV_PASSWORD,
  },
  jitsi: {
    baseUrl: _env.JITSI_BASE_URL,
  },
  smtp: {
    host: _env.SMTP_HOST,
    port: _env.SMTP_PORT,
    secure: _env.SMTP_SECURE,
    user: _env.SMTP_USER,
    pass: _env.SMTP_PASS,
    from: _env.SMTP_FROM,
    fromName: _env.SMTP_FROM_NAME,
  },
  oauth: {
    google: {
      clientId: _env.GOOGLE_CLIENT_ID,
      clientSecret: _env.GOOGLE_CLIENT_SECRET,
      callbackUrl: _env.GOOGLE_CALLBACK_URL,
    },
    github: {
      clientId: _env.GITHUB_CLIENT_ID,
      clientSecret: _env.GITHUB_CLIENT_SECRET,
      callbackUrl: _env.GITHUB_CALLBACK_URL,
    },
  },
} as const;
