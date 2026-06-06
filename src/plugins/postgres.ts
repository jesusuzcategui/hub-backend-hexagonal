import fp from "fastify-plugin";
import { Pool } from "pg";
import { FastifyInstance } from "fastify";
import { env } from "../config/env";
import { createDrizzle, type DrizzleDb } from "../db";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    drizzle: DrizzleDb;
  }
}

async function postgresPlugin(fastify: FastifyInstance): Promise<void> {
  const pool = new Pool({ connectionString: env.database.url });

  await pool.query("SELECT 1");
  fastify.log.info("PostgreSQL connected");

  fastify.decorate("db", pool);
  fastify.decorate("drizzle", createDrizzle(pool));
  fastify.addHook("onClose", async () => pool.end());
}

export default fp(postgresPlugin, { name: "postgres" });
