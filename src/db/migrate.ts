import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { env } from "../config/env";

export async function runMigrations(): Promise<void> {
  console.log("[migrate] connecting to DB...");
  const pool = new Pool({ connectionString: env.database.url });
  const db = drizzle(pool);
  console.log("[migrate] running migrations from ./drizzle/migrations");
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  console.log("[migrate] done.");
  await pool.end();
}

// Run as standalone script
if (require.main === module) {
  runMigrations()
    .then(() => { console.log("Migrations applied."); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
