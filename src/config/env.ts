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

  // ePayco (Colombia) — direct HTTP integration, no SDK (see epayco-provider.ts).
  EPAYCO_CUST_ID_CLIENTE: z.string().default(""),
  EPAYCO_P_KEY: z.string().default(""),
  EPAYCO_PUBLIC_KEY: z.string().default(""),
  // Distinct from EPAYCO_P_KEY: this is the API Public/Private Key pair
  // (dashboard: Integraciones -> Llaves API), used only for the
  // login/token call when creating a checkout session. EPAYCO_P_KEY is the
  // separate secret used for the webhook confirmation signature.
  EPAYCO_PRIVATE_KEY: z.string().default(""),
  EPAYCO_VALIDATION_BASE_URL: z.string().default("https://api.epayco.co"),
  EPAYCO_SUCCESS_URL: z.string().default(""),
  EPAYCO_FAILURE_URL: z.string().default(""),
  EPAYCO_PENDING_URL: z.string().default(""),
  EPAYCO_CONFIRMATION_URL: z.string().default(""),

  // WebDAV (Nextcloud) — manual bank transfer proof uploads.
  WEBDAV_URL: z.string().default(""),
  WEBDAV_USERNAME: z.string().default(""),
  WEBDAV_PASSWORD: z.string().default(""),

  // Umami — server-side purchase event dispatch.
  UMAMI_URL: z.string().default(""),
  UMAMI_WEBSITE_ID: z.string().default(""),

  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  PAYPAL_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_WEBHOOK_ID: z.string().optional().or(z.literal('')).transform(v => v || undefined),
  PAYPAL_SUCCESS_URL: z.string().default(""),
  PAYPAL_CANCEL_URL: z.string().default(""),

  WP_URL: z.string().url(),
  WP_APP_USER: z.string().min(1),
  WP_APP_PASS: z.string().min(1),
  WP_WEBHOOK_SECRET: z.string().min(32),

  // Legacy: only used by portfolio reviews until they move to WordPress.
  STRAPI_URL: z.string().url().optional().or(z.literal('')).transform(v => v || undefined),
  STRAPI_TOKEN: z.string().optional().or(z.literal('')).transform(v => v || undefined),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional().or(z.literal('')).transform(v => v || undefined),

  CALDAV_URL: z.string().url(),
  CALDAV_USERNAME: z.string().min(1),
  CALDAV_PASSWORD: z.string().min(1),

  JITSI_BASE_URL: z.string().url().default("https://talk.jesusuzcategui.com"),

  MENTORING_TEACHER_ID: z.string().uuid(),
  PORTFOLIO_ORIGIN: z.string().url().optional().or(z.literal('')).transform(v => v || undefined),
  CAMPUS_ORIGIN: z.string().url().optional().or(z.literal('')).transform(v => v || undefined),
  ADMIN_NOTIFICATION_EMAIL: z.string().email().optional().or(z.literal('')).transform(v => v || undefined),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.string().default("false").transform((v) => v === "true"),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM: z.string().min(1).default("hello@vanjex.dev"),
  SMTP_FROM_NAME: z.string().min(1).default("Jesus Uzcategui"),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z.string().url().optional().or(z.literal('')).transform(v => v || undefined),

  CAP_SITE_KEY: z.string().optional(),
  CAP_PRIVATE_KEY: z.string().optional(),
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
  epayco: {
    custIdCliente: _env.EPAYCO_CUST_ID_CLIENTE,
    pKey: _env.EPAYCO_P_KEY,
    publicKey: _env.EPAYCO_PUBLIC_KEY,
    privateKey: _env.EPAYCO_PRIVATE_KEY,
    validationBaseUrl: _env.EPAYCO_VALIDATION_BASE_URL,
    successUrl: _env.EPAYCO_SUCCESS_URL,
    failureUrl: _env.EPAYCO_FAILURE_URL,
    pendingUrl: _env.EPAYCO_PENDING_URL,
    confirmationUrl: _env.EPAYCO_CONFIRMATION_URL,
  },
  webdav: {
    url: _env.WEBDAV_URL,
    username: _env.WEBDAV_USERNAME,
    password: _env.WEBDAV_PASSWORD,
  },
  umami: {
    url: _env.UMAMI_URL,
    websiteId: _env.UMAMI_WEBSITE_ID,
  },
  paypal: {
    clientId: _env.PAYPAL_CLIENT_ID,
    clientSecret: _env.PAYPAL_CLIENT_SECRET,
    mode: _env.PAYPAL_MODE,
    webhookId: _env.PAYPAL_WEBHOOK_ID,
    successUrl: _env.PAYPAL_SUCCESS_URL,
    cancelUrl: _env.PAYPAL_CANCEL_URL,
  },
  wp: {
    url: _env.WP_URL,
    appUser: _env.WP_APP_USER,
    appPass: _env.WP_APP_PASS,
    webhookSecret: _env.WP_WEBHOOK_SECRET,
  },
  // Legacy: only used by portfolio reviews until they move to WordPress.
  strapi: {
    url: _env.STRAPI_URL,
    token: _env.STRAPI_TOKEN,
  },
  caldav: {
    url: _env.CALDAV_URL,
    username: _env.CALDAV_USERNAME,
    password: _env.CALDAV_PASSWORD,
  },
  jitsi: {
    baseUrl: _env.JITSI_BASE_URL,
  },
  mentoring: {
    teacherId: _env.MENTORING_TEACHER_ID,
    portfolioOrigin: _env.PORTFOLIO_ORIGIN,
  },
  campus: {
    origin: _env.CAMPUS_ORIGIN,
    adminNotificationEmail: _env.ADMIN_NOTIFICATION_EMAIL,
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
  captcha: {
    siteKey: _env.CAP_SITE_KEY,
    privateKey: _env.CAP_PRIVATE_KEY,
  },
} as const;
