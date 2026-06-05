import { buildApp } from "./app";
import { env } from "./config/env";

const start = async (): Promise<void> => {
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
