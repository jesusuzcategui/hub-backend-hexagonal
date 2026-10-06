import type { BusyInterval } from "./ics";

export interface ExistingBlock {
  id: string;
  externalKey: string;
  startsAt: Date;
  endsAt: Date;
  externalSummary: string | null;
}

export interface SyncPlan {
  insert: BusyInterval[];
  update: Array<{ id: string; interval: BusyInterval }>;
  /** Rows that already match the calendar: only their synced_at is refreshed, they are not counted as updates. */
  unchanged: string[];
  remove: string[];
}

/**
 * Diff between the caldav rows already stored and the busy intervals of this pass. Pure.
 * An unseen row is removed only when it overlaps the sync window: rows entirely in the past (or beyond the
 * horizon, which the REPORT never asked about) say nothing about the calendar and are left alone.
 */
export function planSync(existing: ExistingBlock[], intervals: BusyInterval[], window: { start: Date; end: Date }): SyncPlan {
  const byKey = new Map(existing.map((e) => [e.externalKey, e]));
  const seen = new Set<string>();
  const plan: SyncPlan = { insert: [], update: [], unchanged: [], remove: [] };

  for (const interval of intervals) {
    seen.add(interval.key);
    const row = byKey.get(interval.key);
    if (!row) {
      plan.insert.push(interval);
    } else if (
      row.startsAt.getTime() !== interval.startsAt.getTime() ||
      row.endsAt.getTime() !== interval.endsAt.getTime() ||
      row.externalSummary !== interval.summary
    ) {
      plan.update.push({ id: row.id, interval });
    } else {
      plan.unchanged.push(row.id);
    }
  }

  for (const row of existing) {
    if (seen.has(row.externalKey)) continue;
    if (row.endsAt.getTime() > window.start.getTime() && row.startsAt.getTime() < window.end.getTime()) plan.remove.push(row.id);
  }
  return plan;
}

/** First two characters of an event title followed by "***". Used wherever a title must be shown in a dry run. */
export function maskSummary(summary: string | null): string | null {
  if (summary === null) return null;
  const trimmed = summary.trim();
  if (!trimmed) return null;
  return `${[...trimmed].slice(0, 2).join("")}***`;
}
