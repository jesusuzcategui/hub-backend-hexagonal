import { describe, it, expect } from "vitest";
import { parseCalendarData, mergeIntervals, type ParseOptions } from "../ics";

const opts = (over: Partial<ParseOptions> = {}): ParseOptions => ({
  windowStart: new Date("2026-10-05T00:00:00Z"),
  windowEnd: new Date(Date.parse("2026-10-05T00:00:00Z") + 16 * 7 * 86_400_000),
  allDayBlocks: true,
  ...over,
});

const cal = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const iso = (d: Date) => d.toISOString();

describe("parseCalendarData: single timed events", () => {
  it("UTC ('Z') event: blocks [start,end)", () => {
    const r = parseCalendarData(cal(vevent("UID:e1", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z", "SUMMARY:Clase de ingles")), opts());
    expect(r.intervals).toHaveLength(1);
    expect(iso(r.intervals[0].startsAt)).toBe("2026-10-08T11:00:00.000Z");
    expect(iso(r.intervals[0].endsAt)).toBe("2026-10-08T12:00:00.000Z");
    expect(r.intervals[0].summary).toBe("Clase de ingles");
    expect(r.intervals[0].allDay).toBe(false);
  });

  it("TZID=America/Bogota: Thursday 8 Oct 6:00-7:00 AM becomes 11:00Z-12:00Z", () => {
    const r = parseCalendarData(
      cal(vevent("UID:e2", "DTSTART;TZID=America/Bogota:20261008T060000", "DTEND;TZID=America/Bogota:20261008T070000", "SUMMARY:Clase de ingles")),
      opts(),
    );
    expect(r.intervals.map((i) => [iso(i.startsAt), iso(i.endsAt)])).toEqual([["2026-10-08T11:00:00.000Z", "2026-10-08T12:00:00.000Z"]]);
  });

  it("TZID=Europe/Madrid (CEST, UTC+2 in October): 13:00 Madrid is 11:00Z", () => {
    const r = parseCalendarData(
      cal(vevent("UID:e3", "DTSTART;TZID=Europe/Madrid:20261008T130000", "DTEND;TZID=Europe/Madrid:20261008T140000")),
      opts(),
    );
    expect(iso(r.intervals[0].startsAt)).toBe("2026-10-08T11:00:00.000Z");
    expect(iso(r.intervals[0].endsAt)).toBe("2026-10-08T12:00:00.000Z");
  });

  it("Europe/Madrid after the DST change (CET, UTC+1) uses the right offset", () => {
    const r = parseCalendarData(
      cal(vevent("UID:e3b", "DTSTART;TZID=Europe/Madrid:20261101T130000", "DTEND;TZID=Europe/Madrid:20261101T140000")),
      opts(),
    );
    expect(iso(r.intervals[0].startsAt)).toBe("2026-11-01T12:00:00.000Z");
  });

  it("floating time (no TZ) is read as America/Bogota", () => {
    const r = parseCalendarData(cal(vevent("UID:e4", "DTSTART:20261008T060000", "DTEND:20261008T070000")), opts());
    expect(iso(r.intervals[0].startsAt)).toBe("2026-10-08T11:00:00.000Z");
    expect(iso(r.intervals[0].endsAt)).toBe("2026-10-08T12:00:00.000Z");
  });

  it("a TZID that only exists as a VTIMEZONE in the file is honoured", () => {
    const vtz = [
      "BEGIN:VTIMEZONE",
      "TZID:Custom Standard Zone",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
    ].join("\r\n");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", vtz, vevent('UID:e5', 'DTSTART;TZID="Custom Standard Zone":20261008T100000', 'DTEND;TZID="Custom Standard Zone":20261008T110000'), "END:VCALENDAR"].join("\r\n");
    const r = parseCalendarData(ics, opts());
    expect(iso(r.intervals[0].startsAt)).toBe("2026-10-08T09:00:00.000Z");
  });

  it("uses DURATION when there is no DTEND", () => {
    const r = parseCalendarData(cal(vevent("UID:e6", "DTSTART:20261008T110000Z", "DURATION:PT90M")), opts());
    expect(iso(r.intervals[0].endsAt)).toBe("2026-10-08T12:30:00.000Z");
  });

  it("ignores a timed event with neither DTEND nor DURATION (zero length) and counts it", () => {
    const r = parseCalendarData(cal(vevent("UID:e7", "DTSTART:20261008T110000Z")), opts());
    expect(r.intervals).toEqual([]);
    expect(r.stats.skippedZeroLength).toBe(1);
  });

  it("drops events fully outside the window", () => {
    const r = parseCalendarData(
      cal(
        vevent("UID:past", "DTSTART:20260901T110000Z", "DTEND:20260901T120000Z"),
        vevent("UID:far", "DTSTART:20271001T110000Z", "DTEND:20271001T120000Z"),
        vevent("UID:ongoing", "DTSTART:20261004T230000Z", "DTEND:20261005T010000Z"),
      ),
      opts(),
    );
    expect(r.intervals.map((i) => i.key.split("|")[0])).toEqual(["ongoing"]);
  });
});

describe("parseCalendarData: what does not block", () => {
  it("TRANSP:TRANSPARENT is skipped and counted", () => {
    const r = parseCalendarData(cal(vevent("UID:t1", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z", "TRANSP:TRANSPARENT")), opts());
    expect(r.intervals).toEqual([]);
    expect(r.stats.skippedTransparent).toBe(1);
  });

  it("TRANSP:OPAQUE blocks", () => {
    const r = parseCalendarData(cal(vevent("UID:t2", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z", "TRANSP:OPAQUE")), opts());
    expect(r.intervals).toHaveLength(1);
  });

  it("STATUS:CANCELLED is skipped and counted; TENTATIVE still blocks", () => {
    const r = parseCalendarData(
      cal(
        vevent("UID:c1", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z", "STATUS:CANCELLED"),
        vevent("UID:c2", "DTSTART:20261009T110000Z", "DTEND:20261009T120000Z", "STATUS:TENTATIVE"),
      ),
      opts(),
    );
    expect(r.intervals.map((i) => i.key.split("|")[0])).toEqual(["c2"]);
    expect(r.stats.skippedCancelled).toBe(1);
  });

  it("events written by the platform (<uuid>@vanjex.dev) never block themselves", () => {
    const bookingUid = "3f2b8c1e-5d4a-4b7e-9c0f-1a2b3c4d5e6f@vanjex.dev";
    const requestUid = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE@vanjex.dev";
    const r = parseCalendarData(
      cal(
        vevent(`UID:${bookingUid}`, "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z", "SUMMARY:Clase - Plan - Ana"),
        vevent(`UID:${requestUid}`, "DTSTART:20261009T110000Z", "DTEND:20261009T120000Z", "SUMMARY:Asesoria - WordPress"),
        vevent("UID:owner-event@nextcloud", "DTSTART:20261010T110000Z", "DTEND:20261010T120000Z"),
      ),
      opts(),
    );
    expect(r.stats.skippedPlatformEvents).toBe(2);
    expect(r.intervals.map((i) => i.key.split("|")[0])).toEqual(["owner-event@nextcloud"]);
  });

  it("an owner event whose UID merely ends in @vanjex.dev but is not a uuid still blocks", () => {
    const r = parseCalendarData(cal(vevent("UID:vacaciones@vanjex.dev", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z")), opts());
    expect(r.intervals).toHaveLength(1);
  });
});

describe("parseCalendarData: all-day events", () => {
  it("single all-day event blocks the whole Bogota day", () => {
    const r = parseCalendarData(cal(vevent("UID:d1", "DTSTART;VALUE=DATE:20261009", "DTEND;VALUE=DATE:20261010", "SUMMARY:Libre")), opts());
    expect(r.intervals).toHaveLength(1);
    expect(iso(r.intervals[0].startsAt)).toBe("2026-10-09T05:00:00.000Z");
    expect(iso(r.intervals[0].endsAt)).toBe("2026-10-10T05:00:00.000Z");
    expect(r.intervals[0].allDay).toBe(true);
  });

  it("multi-day all-day event (DTEND exclusive) blocks every day of the range", () => {
    const r = parseCalendarData(cal(vevent("UID:d2", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261015")), opts());
    expect(iso(r.intervals[0].startsAt)).toBe("2026-10-12T05:00:00.000Z");
    expect(iso(r.intervals[0].endsAt)).toBe("2026-10-15T05:00:00.000Z");
  });

  it("an all-day event without DTEND lasts one day", () => {
    const r = parseCalendarData(cal(vevent("UID:d3", "DTSTART;VALUE=DATE:20261009")), opts());
    expect(iso(r.intervals[0].endsAt)).toBe("2026-10-10T05:00:00.000Z");
  });

  it("allDayBlocks=false skips them and counts", () => {
    const r = parseCalendarData(cal(vevent("UID:d4", "DTSTART;VALUE=DATE:20261009", "DTEND;VALUE=DATE:20261010")), opts({ allDayBlocks: false }));
    expect(r.intervals).toEqual([]);
    expect(r.stats.skippedAllDay).toBe(1);
  });
});

describe("parseCalendarData: recurrence", () => {
  const weekly = vevent(
    "UID:w1",
    "DTSTART;TZID=America/Bogota:20261006T070000",
    "DTEND;TZID=America/Bogota:20261006T080000",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "EXDATE;TZID=America/Bogota:20261013T070000",
    "SUMMARY:Standup",
  );
  const moved = vevent(
    "UID:w1",
    "RECURRENCE-ID;TZID=America/Bogota:20261020T070000",
    "DTSTART;TZID=America/Bogota:20261021T090000",
    "DTEND;TZID=America/Bogota:20261021T100000",
    "SUMMARY:Standup (moved)",
  );
  const cancelled = vevent(
    "UID:w1",
    "RECURRENCE-ID;TZID=America/Bogota:20261027T070000",
    "DTSTART;TZID=America/Bogota:20261027T070000",
    "DTEND;TZID=America/Bogota:20261027T080000",
    "STATUS:CANCELLED",
  );

  it("weekly RRULE with EXDATE, a moved RECURRENCE-ID override and a cancelled override", () => {
    const r = parseCalendarData(cal(weekly, moved, cancelled), opts());
    expect(r.intervals.map((i) => [iso(i.startsAt), iso(i.endsAt)])).toEqual([
      ["2026-10-06T12:00:00.000Z", "2026-10-06T13:00:00.000Z"],
      ["2026-10-21T14:00:00.000Z", "2026-10-21T15:00:00.000Z"],
    ]);
    expect(r.intervals[1].summary).toBe("Standup (moved)");
    expect(r.stats.skippedCancelled).toBe(1);
  });

  it("the override's key is anchored to its ORIGINAL recurrence instant (stable if it is moved again)", () => {
    const r = parseCalendarData(cal(weekly, moved, cancelled), opts());
    expect(r.intervals[1].key).toBe("w1|2026-10-20T12:00:00.000Z");
  });

  it("an unbounded RRULE is cut at the window end", () => {
    const r = parseCalendarData(
      cal(vevent("UID:inf", "DTSTART:20261006T120000Z", "DTEND:20261006T130000Z", "RRULE:FREQ=DAILY")),
      opts({ windowEnd: new Date("2026-10-12T00:00:00Z") }),
    );
    expect(r.intervals).toHaveLength(6); // Oct 6..11
  });

  it("a recurrence started long before the window still yields its in-window instances", () => {
    const r = parseCalendarData(
      cal(vevent("UID:old", "DTSTART:20240102T120000Z", "DTEND:20240102T130000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU")),
      opts({ windowEnd: new Date("2026-10-20T00:00:00Z") }),
    );
    expect(r.intervals.map((i) => iso(i.startsAt))).toEqual(["2026-10-06T12:00:00.000Z", "2026-10-13T12:00:00.000Z"]);
  });

  it("weekly local-time recurrence across a DST change keeps the local hour (Europe/Madrid)", () => {
    const r = parseCalendarData(
      cal(vevent("UID:dst", "DTSTART;TZID=Europe/Madrid:20261022T100000", "DTEND;TZID=Europe/Madrid:20261022T110000", "RRULE:FREQ=WEEKLY;COUNT=2")),
      opts(),
    );
    expect(r.intervals.map((i) => iso(i.startsAt))).toEqual(["2026-10-22T08:00:00.000Z", "2026-10-29T09:00:00.000Z"]);
  });

  it("server-expanded input (one VEVENT per instance with RECURRENCE-ID, no RRULE) yields the same keys as local expansion", () => {
    const local = parseCalendarData(cal(vevent("UID:x", "DTSTART:20261006T120000Z", "DTEND:20261006T130000Z", "RRULE:FREQ=WEEKLY;COUNT=3")), opts());
    const expanded = parseCalendarData(
      cal(
        vevent("UID:x", "RECURRENCE-ID:20261006T120000Z", "DTSTART:20261006T120000Z", "DTEND:20261006T130000Z"),
        vevent("UID:x", "RECURRENCE-ID:20261013T120000Z", "DTSTART:20261013T120000Z", "DTEND:20261013T130000Z"),
        vevent("UID:x", "RECURRENCE-ID:20261020T120000Z", "DTSTART:20261020T120000Z", "DTEND:20261020T130000Z"),
      ),
      opts(),
    );
    expect(expanded.intervals.map((i) => i.key)).toEqual(local.intervals.map((i) => i.key));
    expect(local.intervals).toHaveLength(3);
  });
});

describe("parseCalendarData: keys and robustness", () => {
  it("keys are stable across parses and independent of the title", () => {
    const a = parseCalendarData(cal(vevent("UID:k1", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z", "SUMMARY:One")), opts());
    const b = parseCalendarData(cal(vevent("UID:k1", "DTEND:20261008T120000Z", "DTSTART:20261008T110000Z", "SUMMARY:Renamed")), opts());
    expect(a.intervals[0].key).toBe("k1|2026-10-08T11:00:00.000Z");
    expect(b.intervals[0].key).toBe(a.intervals[0].key);
  });

  it("the same event expressed in another zone has the same key", () => {
    const a = parseCalendarData(cal(vevent("UID:k2", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z")), opts());
    const b = parseCalendarData(cal(vevent("UID:k2", "DTSTART;TZID=America/Bogota:20261008T060000", "DTEND;TZID=America/Bogota:20261008T070000")), opts());
    expect(b.intervals[0].key).toBe(a.intervals[0].key);
  });

  it("two VEVENTs with the same UID and instant collapse to one interval", () => {
    const e = vevent("UID:dup", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z");
    expect(parseCalendarData(cal(e, e), opts()).intervals).toHaveLength(1);
  });

  it("unfolds long SUMMARY lines and unescapes text", () => {
    const r = parseCalendarData(
      cal(vevent("UID:s1", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z", "SUMMARY:Clase\\, con coma y una linea muy larga que ", " se dobla segun RFC 5545")),
      opts(),
    );
    expect(r.intervals[0].summary).toBe("Clase, con coma y una linea muy larga que se dobla segun RFC 5545");
  });

  it("a missing SUMMARY gives a null summary", () => {
    const r = parseCalendarData(cal(vevent("UID:s2", "DTSTART:20261008T110000Z", "DTEND:20261008T120000Z")), opts());
    expect(r.intervals[0].summary).toBeNull();
  });

  it("malformed iCalendar text throws a parse error", () => {
    expect(() => parseCalendarData("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART:not-a-date", opts())).toThrow();
    expect(() => parseCalendarData("<html>login</html>", opts())).toThrow();
    expect(() => parseCalendarData("", opts())).toThrow();
  });

  it("a VEVENT without UID or DTSTART is skipped and counted, the rest is kept", () => {
    const r = parseCalendarData(cal(vevent("DTSTART:20261008T110000Z", "DTEND:20261008T120000Z"), vevent("UID:ok", "DTSTART:20261009T110000Z", "DTEND:20261009T120000Z")), opts());
    expect(r.intervals).toHaveLength(1);
    expect(r.stats.skippedInvalid).toBe(1);
  });
});

describe("mergeIntervals", () => {
  const d = (s: string) => new Date(`2026-10-08T${s}:00Z`);
  it("merges overlapping and touching intervals, keeps disjoint ones, sorts", () => {
    const merged = mergeIntervals([
      { startsAt: d("14:00"), endsAt: d("15:00") },
      { startsAt: d("10:00"), endsAt: d("11:00") },
      { startsAt: d("10:30"), endsAt: d("12:00") },
      { startsAt: d("12:00"), endsAt: d("12:30") },
    ]);
    expect(merged.map((m) => [m.startsAt.toISOString().slice(11, 16), m.endsAt.toISOString().slice(11, 16)])).toEqual([
      ["10:00", "12:30"],
      ["14:00", "15:00"],
    ]);
  });
  it("returns [] for no input and does not mutate it", () => {
    expect(mergeIntervals([])).toEqual([]);
    const input = [{ startsAt: d("10:00"), endsAt: d("11:00") }];
    mergeIntervals(input);
    expect(input).toHaveLength(1);
  });
});
