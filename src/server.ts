import { buildApp } from "./app";
import { env } from "./config/env";
import { runMigrations } from "./db/migrate";

const start = async (): Promise<void> => {
  try {
    await runMigrations();
  } catch (err) {
    console.error("[migrate] FAILED:", err);
    process.exit(1);
  }

  const app = buildApp();

  try {
    await app.listen({
      port: env.server.port,
      host: "0.0.0.0",
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();
