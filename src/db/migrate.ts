import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { env } from "../config/env";

async function repairSchema(pool: Pool): Promise<void> {
  // 0005: account_status enum + columns
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
  // 0006: mentoring_requests table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduling.mentoring_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      name text NOT NULL,
      email text NOT NULL,
      whatsapp text,
      type text NOT NULL,
      message text,
      slot_id text NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      gcal_event_id text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mentoring_requests_slot_id ON scheduling.mentoring_requests (slot_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mentoring_requests_starts_at ON scheduling.mentoring_requests (starts_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mentoring_requests_status ON scheduling.mentoring_requests (status)`);
  console.log("[migrate] schema repair done.");
}

export async function runMigrations(): Promise<void> {
  console.log("[migrate] connecting to DB...");
  const pool = new Pool({ connectionString: env.database.url });
  const db = drizzle(pool);
  console.log("[migrate] running migrations from ./drizzle/migrations");
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  await repairSchema(pool);
  console.log("[migrate] done.");
  await pool.end();
}

// Run as standalone script
if (require.main === module) {
  runMigrations()
    .then(() => { console.log("Migrations applied."); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
