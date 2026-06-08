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

  STRAPI_URL: z.string().url(),
  STRAPI_TOKEN: z.string().min(1),
  STRAPI_WEBHOOK_SECRET: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

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
  strapi: {
    url: _env.STRAPI_URL,
    token: _env.STRAPI_TOKEN,
    webhookSecret: _env.STRAPI_WEBHOOK_SECRET,
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
