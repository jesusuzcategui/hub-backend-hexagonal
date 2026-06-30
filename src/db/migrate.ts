import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { env } from "../config/env";

async function repairSchema(pool: Pool): Promise<void> {
  // Ensures DDL from migration 0005 is actually applied regardless of tracking table state
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'account_status' AND n.nspname = 'users'
      ) THEN
        CREATE TYPE users.account_status AS ENUM('active', 'suspended', 'blocked', 'deleted');
      END IF;
    END $$
  `);
  await pool.query(`ALTER TABLE users.accounts ADD COLUMN IF NOT EXISTS status users.account_status NOT NULL DEFAULT 'active'`);
  await pool.query(`ALTER TABLE users.accounts ADD COLUMN IF NOT EXISTS suspended_at timestamptz`);
  await pool.query(`ALTER TABLE users.accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON users.accounts USING btree (status)`);
  console.log("[migrate] schema repair done.");
}

export async function runMigrations(): Promise<void> {
  console.log("[migrate] connecting to DB...");
  const pool = new Pool({ connectionString: env.database.url });
  await repairSchema(pool);
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
