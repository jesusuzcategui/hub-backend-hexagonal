import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema/index.js";
import { weeklySlots } from "./schema/scheduling.js";
import { env } from "../config/env.js";
import slots from "../../mentoring-availability.json" assert { type: "json" };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const teacherId = env.mentoring.teacherId;

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
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
