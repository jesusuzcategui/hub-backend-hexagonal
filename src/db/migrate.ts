import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { env } from "../config/env";

export async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: env.database.url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  await pool.end();
}
