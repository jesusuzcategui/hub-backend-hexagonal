import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema/index.js";
import { weeklySlots } from "./schema/scheduling.js";
import { accounts } from "./schema/users.js";
import { env } from "../config/env.js";

interface SlotEntry {
  id: string;
  day: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

const slots: SlotEntry[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "mentoring-availability.json"), "utf8"),
);

export async function seedMentoring(existingPool?: import("pg").Pool): Promise<void> {
  const pool = existingPool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const teacherId = env.mentoring.teacherId;

  // Ensure teacher account exists (FK required by weekly_slots.teacher_id)
  await db
    .insert(accounts)
    .values({
      id: teacherId,
      email: "hola@jesusuzcategui.com",
      displayName: "Jesus Uzcategui",
      emailVerified: true,
      isActive: true,
    })
    .onConflictDoNothing({ target: accounts.id });
  console.log("  teacher account ready");

  for (const slot of slots) {
    const existing = await db
      .select({ id: weeklySlots.id })
      .from(weeklySlots)
      .where(eq(weeklySlots.id, slot.id))
      .limit(1);

    if (existing.length > 0) {
      console.log(`  skip  ${slot.day} ${slot.start_time}–${slot.end_time} (already exists)`);
      continue;
    }

    await db.insert(weeklySlots).values({
      id: slot.id,
      teacherId,
      dayOfWeek: slot.day_of_week,
      startTime: slot.start_time,
      endTime: slot.end_time,
      isActive: slot.is_active,
    });

    console.log(`  added ${slot.day} ${slot.start_time}–${slot.end_time}`);
  }

  console.log("Mentoring slots seeded.");
  if (!existingPool) await pool.end();
}

async function waitForTable(pool: Pool, maxWaitMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'users' AND table_name = 'accounts'`
    );
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timeout: users.accounts not ready after 30s");
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await waitForTable(pool);
  await seedMentoring(pool);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
