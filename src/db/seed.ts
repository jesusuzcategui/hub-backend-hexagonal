import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as argon2 from "argon2";
import * as schema from "./schema";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

// ADMIN_EMAIL/ADMIN_PASSWORD let staging/prod override the admin account
// from Coolify's env vars instead of shipping a hardcoded password in
// source — same pattern as every other secret this app already uses.
// Unset locally, so dev behavior is unchanged. When they ARE set, this is
// clearly not a dev run, so the throwaway test account is skipped too —
// it has no business existing outside dev.
const adminOverride = Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD);

const USERS = [
  {
    email: process.env.ADMIN_EMAIL || "admin@hub.dev",
    displayName: "Admin",
    password: process.env.ADMIN_PASSWORD || "Admin1234!",
    role: "admin" as const,
  },
  ...(adminOverride
    ? []
    : [
        {
          email: "user@hub.dev",
          displayName: "Test User",
          password: "User1234!",
          role: "user" as const,
        },
      ]),
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  console.log("🌱 Seeding...");

  for (const u of USERS) {
    const passwordHash = await argon2.hash(u.password, ARGON2_OPTIONS);
    const values = {
      email: u.email,
      displayName: u.displayName,
      passwordHash,
      role: u.role,
      emailVerified: true,
      isActive: true,
    };

    // Override mode (ADMIN_EMAIL/ADMIN_PASSWORD set): upsert, so changing
    // the env var and redeploying actually rotates the password — that's
    // the whole point of sourcing it from there. Default dev mode: insert
    // once, leave alone after (onConflictDoNothing), same as before.
    const [result] = adminOverride
      ? await db
          .insert(schema.accounts)
          .values(values)
          .onConflictDoUpdate({ target: schema.accounts.email, set: { passwordHash, role: u.role } })
          .returning({ id: schema.accounts.id, email: schema.accounts.email })
      : await db
          .insert(schema.accounts)
          .values(values)
          .onConflictDoNothing({ target: schema.accounts.email })
          .returning({ id: schema.accounts.id, email: schema.accounts.email });

    // Never print the real password when it came from an env var override
    // (ADMIN_PASSWORD) — this runs as Coolify's post-deployment command, and
    // deploy logs are retained/exportable. The hardcoded dev password is
    // already public (it's in this file), so printing that one is harmless.
    const passwordLabel = adminOverride ? "(from ADMIN_PASSWORD)" : `(${u.password})`;
    if (result) {
      console.log(`  ✓ ${u.role.padEnd(5)}  ${u.email}  ${passwordLabel}`);
    } else {
      console.log(`  –       ${u.email}  already exists, skipped`);
    }
  }

  await pool.end();
  console.log("Done.");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
