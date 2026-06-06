import "dotenv/config";

const requiredEnvVars = [
  "STATE_SECRET",
  "PORT",
  "DATABASE_URL",
  "REDIS_URL",
] as const;

type EnvVar = (typeof requiredEnvVars)[number];

const validateEnv = (): void => {
  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
};

validateEnv();

const allowedHosts = (process.env.ALLOWED_REDIRECT_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export const env = {
  server: {
    port: parseInt(process.env.PORT as string, 10),
    stateSecret: process.env.STATE_SECRET as string,
    allowedRedirectHosts: new Set(allowedHosts),
  },
  database: {
    url: process.env.DATABASE_URL as string,
  },
  cache: {
    url: process.env.REDIS_URL as string,
  },
} as const;
