/**
 * Settings of the calendar sync, read lazily from the environment (not from config/env.ts, which is frozen at
 * import time and would make the sync impossible to point at a fake server in tests).
 *
 *   CALDAV_URL / CALDAV_USERNAME / CALDAV_PASSWORD  the owner's calendar collection (shared with the write side)
 *   MENTORING_TEACHER_ID                            the teacher the synced blocks belong to
 *   CALDAV_SYNC_HORIZON_WEEKS  default 16, 1..52    how far ahead busy time is mirrored
 *   CALDAV_ALL_DAY_BLOCKS      default true         all-day events block the whole Bogota day(s)
 *   CALDAV_SYNC_EXPAND         default true         ask the server to expand recurrences (C:expand)
 */

export interface CalendarSyncConfig {
  url: string;
  username: string;
  password: string;
  teacherId: string;
  horizonWeeks: number;
  allDayBlocks: boolean;
  expand: boolean;
}

type Vars = Record<string, string | undefined>;

const DEFAULT_HORIZON_WEEKS = 16;
const MAX_HORIZON_WEEKS = 52;

function flag(value: string | undefined): boolean {
  return (value ?? "true").trim().toLowerCase() !== "false";
}

function horizon(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return DEFAULT_HORIZON_WEEKS;
  const n = Number(value.trim());
  if (n < 1) return DEFAULT_HORIZON_WEEKS;
  return Math.min(n, MAX_HORIZON_WEEKS);
}

function required(vars: Vars, name: string): string {
  const v = vars[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

export function resolveSyncConfig(vars: Vars = process.env): CalendarSyncConfig {
  return {
    url: required(vars, "CALDAV_URL"),
    username: required(vars, "CALDAV_USERNAME"),
    password: required(vars, "CALDAV_PASSWORD"),
    teacherId: required(vars, "MENTORING_TEACHER_ID"),
    horizonWeeks: horizon(vars.CALDAV_SYNC_HORIZON_WEEKS),
    allDayBlocks: flag(vars.CALDAV_ALL_DAY_BLOCKS),
    expand: flag(vars.CALDAV_SYNC_EXPAND),
  };
}

/**
 * On by default (the production image does not set NODE_ENV, so we cannot key "on" off it). Off when
 * CALDAV_SYNC_ENABLED=false, and ALWAYS off under NODE_ENV=test. Local `pnpm dev` turns it off through the
 * package.json script, so a laptop never reads the real calendar by accident.
 */
export function calendarSyncEnabled(vars: { NODE_ENV?: string; CALDAV_SYNC_ENABLED?: string }): boolean {
  if (vars.NODE_ENV === "test") return false;
  return (vars.CALDAV_SYNC_ENABLED ?? "true").toLowerCase() !== "false";
}
