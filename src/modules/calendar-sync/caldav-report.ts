/**
 * Read side of the CalDAV integration: a calendar-query REPORT over the owner's calendar collection, and a
 * tolerant parser for the multistatus answer. The write side lives in plugins/caldav.ts.
 *
 * Errors are typed and deliberately carry no response body, URL or credentials: callers log them as-is.
 */

export type CalDavFetchErrorKind = "http" | "network" | "malformed_response";

export class CalDavFetchError extends Error {
  readonly kind: CalDavFetchErrorKind;
  readonly status?: number;
  /** Node error code of the underlying failure (ECONNREFUSED, ...) when there is one. */
  readonly code?: string;

  constructor(kind: CalDavFetchErrorKind, extra: { status?: number; code?: string } = {}) {
    super(kind === "http" ? `CalDAV REPORT failed with HTTP ${extra.status}` : kind === "network" ? "CalDAV request failed" : "CalDAV returned a malformed response");
    this.name = "CalDavFetchError";
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
  }
}

export interface CalDavFetchConfig {
  /** The calendar collection URL (the same one events are PUT into). */
  url: string;
  username: string;
  password: string;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** 20261005T000000Z */
function icalUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildReportBody(start: Date, end: Date, opts: { expand: boolean }): string {
  const s = icalUtc(start);
  const e = icalUtc(end);
  const calendarData = opts.expand
    ? `<C:calendar-data><C:expand start="${s}" end="${e}"/></C:calendar-data>`
    : `<C:calendar-data/>`;
  return [
    `<?xml version="1.0" encoding="utf-8" ?>`,
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">`,
    `<D:prop><D:getetag/>${calendarData}</D:prop>`,
    `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">`,
    `<C:time-range start="${s}" end="${e}"/>`,
    `</C:comp-filter></C:comp-filter></C:filter>`,
    `</C:calendar-query>`,
  ].join("");
}

const NS = String.raw`(?:[\w.-]+:)?`;
const MULTISTATUS_OPEN = new RegExp(`<${NS}multistatus[\\s>/]`);
const MULTISTATUS_CLOSE = new RegExp(`</${NS}multistatus\\s*>|<${NS}multistatus[^>]*/>`);
const RESPONSE = new RegExp(`<${NS}response[\\s>][\\s\\S]*?</${NS}response\\s*>`, "g");
const PROPSTAT = new RegExp(`<${NS}propstat[\\s>][\\s\\S]*?</${NS}propstat\\s*>`, "g");
const STATUS = new RegExp(`<${NS}status\\s*>([^<]*)</${NS}status\\s*>`);
const CALENDAR_DATA = new RegExp(`<${NS}calendar-data(?:\\s[^>]*)?>([\\s\\S]*?)</${NS}calendar-data\\s*>`);

function decodeXmlText(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1];
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Returns the iCalendar text of every successful calendar-data element of a 207 multistatus body. */
export function parseMultistatus(xml: string): string[] {
  if (!MULTISTATUS_OPEN.test(xml) || !MULTISTATUS_CLOSE.test(xml)) throw new CalDavFetchError("malformed_response");

  const out: string[] = [];
  for (const response of xml.match(RESPONSE) ?? []) {
    const propstats = response.match(PROPSTAT) ?? [response];
    for (const block of propstats) {
      const status = block.match(STATUS)?.[1];
      if (status && !/\s2\d\d(\s|$)/.test(status)) continue;
      const data = block.match(CALENDAR_DATA);
      if (data && data[1].trim()) out.push(decodeXmlText(data[1]));
    }
  }
  return out;
}

export async function fetchCalendarData(
  config: CalDavFetchConfig,
  window: { start: Date; end: Date },
  opts: { expand: boolean; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(config.url, {
      method: "REPORT",
      headers: {
        Authorization: basicAuth(config.username, config.password),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: buildReportBody(window.start, window.end, { expand: opts.expand }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } })?.cause;
    throw new CalDavFetchError("network", { code: typeof cause?.code === "string" ? cause.code : undefined });
  }

  // 207 is the protocol answer; a 200 (e.g. a login page) is read as a body and rejected as malformed below.
  if (res.status !== 207 && res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new CalDavFetchError("http", { status: res.status });
  }

  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new CalDavFetchError("network");
  }
  return parseMultistatus(body);
}
