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

const USERS = [
  {
    email: "admin@hub.dev",
    displayName: "Admin",
    password: "Admin1234!",
    role: "admin" as const,
  },
  {
    email: "user@hub.dev",
    displayName: "Test User",
    password: "User1234!",
    role: "user" as const,
  },
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  console.log("🌱 Seeding...");

  for (const u of USERS) {
    const passwordHash = await argon2.hash(u.password, ARGON2_OPTIONS);

    const [inserted] = await db
      .insert(schema.accounts)
      .values({
        email: u.email,
        displayName: u.displayName,
        passwordHash,
        role: u.role,
        emailVerified: true,
        isActive: true,
      })
      .onConflictDoNothing({ target: schema.accounts.email })
      .returning({ id: schema.accounts.id, email: schema.accounts.email });

    if (inserted) {
      console.log(`  ✓ ${u.role.padEnd(5)}  ${u.email}  (${u.password})`);
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
