import ICAL from "ical.js";

/**
 * Turns the iCalendar text of a CalDAV calendar-query response into busy intervals. Pure: no I/O, no clock.
 *
 * Rules (see the calendar sync spec):
 *  - STATUS:CANCELLED and TRANSP:TRANSPARENT never block; timed events block [start, end).
 *  - All-day events (VALUE=DATE) block whole America/Bogota days (the hub hardcodes UTC-5), unless disabled.
 *  - Floating times (no TZ) are read as America/Bogota; any other TZID is converted to a UTC instant.
 *  - Events the platform itself wrote (UID "<uuid>@vanjex.dev") are skipped so a class never blocks itself.
 *  - Recurrences are expanded here (RRULE/EXDATE) when the server did not expand them, and RECURRENCE-ID
 *    overrides replace the instance they point at (cancelled overrides remove it).
 */

export interface ParseOptions {
  /** Intervals that end at or before this instant are dropped. */
  windowStart: Date;
  /** Intervals that start at or after this instant are dropped (also bounds recurrence expansion). */
  windowEnd: Date;
  allDayBlocks: boolean;
}

export interface BusyInterval {
  /** "<UID>|<ISO start of the recurrence instance>": stable across syncs, independent of the title. */
  key: string;
  startsAt: Date;
  endsAt: Date;
  /** Event title. Sensitive: only ever stored in blocked_slots.external_summary (admin-only). */
  summary: string | null;
  allDay: boolean;
}

export interface ParseStats {
  skippedPlatformEvents: number;
  skippedTransparent: number;
  skippedCancelled: number;
  skippedAllDay: number;
  skippedZeroLength: number;
  skippedInvalid: number;
}

export class CalendarParseError extends Error {
  constructor() {
    // Deliberately generic: the underlying message can quote calendar content.
    super("Unparsable iCalendar data");
    this.name = "CalendarParseError";
  }
}

export function emptyStats(): ParseStats {
  return { skippedPlatformEvents: 0, skippedTransparent: 0, skippedCancelled: 0, skippedAllDay: 0, skippedZeroLength: 0, skippedInvalid: 0 };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** America/Bogota is UTC-5 all year (no DST); the rest of the hub hardcodes the same offset. */
const BOGOTA_OFFSET_MS = -5 * HOUR;
const MAX_INSTANCES_PER_EVENT = 5000;
const PLATFORM_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@vanjex\.dev$/i;

// ---------- time zones ----------

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (formatters.has(tz)) return formatters.get(tz)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    f = null; // not an IANA name
  }
  formatters.set(tz, f);
  return f;
}

function tzOffsetMs(instant: number, f: Intl.DateTimeFormat): number {
  const parts = f.formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallToInstantIana(w: Wall, f: Intl.DateTimeFormat): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = guess - tzOffsetMs(guess, f);
  const second = guess - tzOffsetMs(first, f);
  return second;
}

type ZoneKind = { kind: "utc" } | { kind: "floating" } | { kind: "iana"; f: Intl.DateTimeFormat } | { kind: "vtimezone"; zone: ICAL.Timezone };

interface Ctx {
  /** VTIMEZONE definitions found in the file, by TZID (used only for TZIDs that are not IANA names). */
  vtimezones: Map<string, ICAL.Timezone>;
}

function wallOf(t: ICAL.Time): Wall {
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
}

function zoneFor(prop: ICAL.Property, t: ICAL.Time, ctx: Ctx): ZoneKind {
  const tzid = prop.getParameter("tzid");
  if (typeof tzid === "string" && tzid) {
    const f = formatterFor(tzid);
    if (f) return { kind: "iana", f };
    const vtz = ctx.vtimezones.get(tzid);
    if (vtz) return { kind: "vtimezone", zone: vtz };
    return { kind: "floating" }; // unknown zone name: least-bad reading is the owner's local time
  }
  if (t.zone && t.zone.tzid === "UTC") return { kind: "utc" };
  return { kind: "floating" };
}

function toInstant(t: ICAL.Time, zone: ZoneKind): number {
  const w = wallOf(t);
  switch (zone.kind) {
    case "utc":
      return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    case "iana":
      return wallToInstantIana(w, zone.f);
    case "vtimezone": {
      const offsetSeconds = zone.zone.utcOffset(ICAL.Time.fromData(w));
      return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - offsetSeconds * 1000;
    }
    default:
      return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - BOGOTA_OFFSET_MS;
  }
}

/** Midnight (America/Bogota) of the calendar date carried by an all-day value. */
function bogotaMidnight(t: ICAL.Time): number {
  return Date.UTC(t.year, t.month - 1, t.day) - BOGOTA_OFFSET_MS;
}

// ---------- parsing ----------

interface Start {
  allDay: boolean;
  instant: number;
  zone: ZoneKind;
  time: ICAL.Time;
}

function readStart(ve: ICAL.Component, name: "dtstart" | "recurrence-id", ctx: Ctx): Start | null {
  const prop = ve.getFirstProperty(name);
  if (!prop) return null;
  const t = prop.getFirstValue();
  if (!(t instanceof ICAL.Time)) return null;
  if (t.isDate) return { allDay: true, instant: bogotaMidnight(t), zone: { kind: "floating" }, time: t };
  const zone = zoneFor(prop, t, ctx);
  const instant = toInstant(t, zone);
  return Number.isFinite(instant) ? { allDay: false, instant, zone, time: t } : null;
}

function readEnd(ve: ICAL.Component, ctx: Ctx): { allDay: boolean; instant: number } | null {
  const prop = ve.getFirstProperty("dtend");
  if (!prop) return null;
  const t = prop.getFirstValue();
  if (!(t instanceof ICAL.Time)) return null;
  if (t.isDate) return { allDay: true, instant: bogotaMidnight(t) };
  const instant = toInstant(t, zoneFor(prop, t, ctx));
  return Number.isFinite(instant) ? { allDay: false, instant } : null;
}

function durationSeconds(ve: ICAL.Component): number | null {
  const v = ve.getFirstPropertyValue("duration");
  if (!v || typeof (v as ICAL.Duration).toSeconds !== "function") return null;
  return (v as ICAL.Duration).toSeconds();
}

function text(ve: ICAL.Component, name: string): string | null {
  const v = ve.getFirstPropertyValue(name);
  return typeof v === "string" ? v : null;
}

export function parseCalendarData(ics: string, options: ParseOptions): { intervals: BusyInterval[]; stats: ParseStats } {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new CalendarParseError();
  }
  if (root.name !== "vcalendar") throw new CalendarParseError();

  const ctx: Ctx = { vtimezones: new Map() };
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    const tzid = text(vtz, "tzid");
    if (!tzid) continue;
    try {
      ctx.vtimezones.set(tzid, new ICAL.Timezone({ component: vtz, tzid }));
    } catch {
      // an unusable VTIMEZONE only matters if an event references it
    }
  }

  const stats = emptyStats();
  const winStart = options.windowStart.getTime();
  const winEnd = options.windowEnd.getTime();
  const found = new Map<string, BusyInterval>();

  const vevents = root.getAllSubcomponents("vevent");

  // Instants of every override per UID: the master must not also emit those instances.
  const overridden = new Map<string, Set<number>>();
  for (const ve of vevents) {
    const uid = text(ve, "uid");
    if (!uid || !ve.hasProperty("recurrence-id")) continue;
    let rid: Start | null = null;
    try {
      rid = readStart(ve, "recurrence-id", ctx);
    } catch {
      rid = null;
    }
    if (!rid) continue;
    if (!overridden.has(uid)) overridden.set(uid, new Set());
    overridden.get(uid)!.add(rid.instant);
  }

  const add = (interval: BusyInterval) => {
    if (!(interval.startsAt.getTime() < winEnd && interval.endsAt.getTime() > winStart)) return;
    const prev = found.get(interval.key);
    if (!prev || interval.endsAt > prev.endsAt) found.set(interval.key, interval);
  };

  for (const ve of vevents) {
    try {
      const uid = text(ve, "uid");
      if (!uid) {
        stats.skippedInvalid++;
        continue;
      }
      if (PLATFORM_UID.test(uid)) {
        stats.skippedPlatformEvents++;
        continue;
      }
      const status = text(ve, "status");
      if (status && status.toUpperCase() === "CANCELLED") {
        stats.skippedCancelled++;
        continue;
      }
      const transp = text(ve, "transp");
      if (transp && transp.toUpperCase() === "TRANSPARENT") {
        stats.skippedTransparent++;
        continue;
      }

      const start = readStart(ve, "dtstart", ctx);
      if (!start) {
        stats.skippedInvalid++;
        continue;
      }
      if (start.allDay && !options.allDayBlocks) {
        stats.skippedAllDay++;
        continue;
      }

      // Length of one instance, in ms.
      let lengthMs: number;
      const end = readEnd(ve, ctx);
      const dur = durationSeconds(ve);
      if (start.allDay) {
        if (end && end.instant > start.instant) lengthMs = Math.max(1, Math.round((end.instant - start.instant) / DAY)) * DAY;
        else if (dur && dur > 0) lengthMs = Math.max(1, Math.ceil(dur / 86400)) * DAY;
        else lengthMs = DAY;
      } else if (end && !end.allDay) {
        lengthMs = end.instant - start.instant;
      } else if (dur !== null) {
        lengthMs = dur * 1000;
      } else {
        lengthMs = 0;
      }
      if (lengthMs <= 0) {
        stats.skippedZeroLength++;
        continue;
      }

      const summaryRaw = text(ve, "summary");
      const summary = summaryRaw && summaryRaw.trim() ? summaryRaw.trim() : null;
      const emit = (anchorInstant: number, startInstant: number) =>
        add({
          key: `${uid}|${new Date(anchorInstant).toISOString()}`,
          startsAt: new Date(startInstant),
          endsAt: new Date(startInstant + lengthMs),
          summary,
          allDay: start.allDay,
        });

      if (ve.hasProperty("recurrence-id")) {
        const rid = readStart(ve, "recurrence-id", ctx);
        emit(rid ? rid.instant : start.instant, start.instant);
        continue;
      }

      if (ve.hasProperty("rrule") || ve.hasProperty("rdate")) {
        const skip = overridden.get(uid);
        const it = new ICAL.Event(ve).iterator();
        for (let n = 0; n < MAX_INSTANCES_PER_EVENT; n++) {
          const occ = it.next();
          if (!occ) break;
          const instant = start.allDay ? bogotaMidnight(occ) : toInstant(occ, start.zone);
          if (instant >= winEnd) break;
          if (instant + lengthMs <= winStart) continue;
          if (skip?.has(instant)) continue;
          emit(instant, instant);
        }
        continue;
      }

      emit(start.instant, start.instant);
    } catch {
      stats.skippedInvalid++;
    }
  }

  const intervals = [...found.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.key.localeCompare(b.key));
  return { intervals, stats };
}

/** Union of overlapping or touching intervals, sorted. Does not mutate its input. */
export function mergeIntervals<T extends { startsAt: Date; endsAt: Date }>(intervals: T[]): Array<{ startsAt: Date; endsAt: Date }> {
  const sorted = [...intervals].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const out: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.startsAt.getTime() <= last.endsAt.getTime()) {
      if (i.endsAt > last.endsAt) last.endsAt = i.endsAt;
    } else {
      out.push({ startsAt: i.startsAt, endsAt: i.endsAt });
    }
  }
  return out;
}
