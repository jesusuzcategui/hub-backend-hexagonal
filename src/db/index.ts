import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema";

export type DrizzleDb = ReturnType<typeof createDrizzle>;

export function createDrizzle(pool: Pool) {
  return drizzle(pool, { schema });
}
