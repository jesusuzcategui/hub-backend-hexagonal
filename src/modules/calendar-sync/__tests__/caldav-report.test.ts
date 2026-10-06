import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildReportBody, parseMultistatus, fetchCalendarData, CalDavFetchError } from "../caldav-report";

const start = new Date("2026-10-05T00:00:00Z");
const end = new Date("2026-10-12T00:00:00Z");

const ICS_A = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261008T110000Z\r\nDTEND:20261008T120000Z\r\nSUMMARY:Tom & Jerry <b>\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");

const sabre = (...bodies: string[]) =>
  `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">` +
  bodies
    .map(
      (b, i) =>
        `<d:response><d:href>/remote.php/dav/calendars/u/c/e${i}.ics</d:href><d:propstat><d:prop><d:getetag>"x${i}"</d:getetag><cal:calendar-data>${escapeXml(b)}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
    )
    .join("") +
  `</d:multistatus>`;

describe("buildReportBody", () => {
  it("is a calendar-query with a VEVENT time-range in UTC basic format", () => {
    const body = buildReportBody(start, end, { expand: false });
    expect(body).toContain("<C:calendar-query");
    expect(body).toContain('xmlns:C="urn:ietf:params:xml:ns:caldav"');
    expect(body).toContain('<C:comp-filter name="VCALENDAR">');
    expect(body).toContain('<C:comp-filter name="VEVENT">');
    expect(body).toContain('<C:time-range start="20261005T000000Z" end="20261012T000000Z"/>');
    expect(body).toContain("<C:calendar-data");
  });

  it("asks the server to expand recurrences over the same window only when expand is on", () => {
    expect(buildReportBody(start, end, { expand: true })).toContain('<C:expand start="20261005T000000Z" end="20261012T000000Z"/>');
    expect(buildReportBody(start, end, { expand: false })).not.toContain("expand");
  });
});

describe("parseMultistatus", () => {
  it("extracts and XML-unescapes every calendar-data (sabre style, prefixed namespaces)", () => {
    const out = parseMultistatus(sabre(ICS_A, ICS_A.replace("UID:a", "UID:b")));
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ICS_A);
    expect(out[1]).toContain("UID:b");
  });

  it("handles default-namespace XML and CDATA", () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/x.ics</href><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${ICS_A}]]></calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    expect(parseMultistatus(xml)).toEqual([ICS_A]);
  });

  it("ignores propstat blocks that are not 200 (no calendar-data) and responses without data", () => {
    const xml =
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
      `<d:response><d:href>/a.ics</d:href><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>` +
      `<d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
      `</d:multistatus>`;
    expect(parseMultistatus(xml)).toEqual([]);
  });

  it("an empty multistatus is a valid answer: no events", () => {
    expect(parseMultistatus(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`)).toEqual([]);
  });

  it("decodes numeric character references", () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">A&#13;&#10;B&#x41;</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    expect(parseMultistatus(xml)).toEqual(["A\r\nBA"]);
  });

  it.each([
    ["an HTML login page", "<html><body>Please log in</body></html>"],
    ["plain text", "nope"],
    ["empty body", ""],
    ["a truncated multistatus", `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x`],
  ])("throws a malformed_response error for %s", (_n, body) => {
    try {
      parseMultistatus(body);
    } catch (err) {
      expect(err).toBeInstanceOf(CalDavFetchError);
      expect((err as CalDavFetchError).kind).toBe("malformed_response");
      return;
    }
    throw new Error("expected a throw");
  });
});

describe("fetchCalendarData (local fake server)", () => {
  let server: http.Server | undefined;
  let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } | undefined;

  async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        handler(req, res);
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/remote.php/dav/calendars/owner/main`;
  }

  afterEach(async () => {
    seen = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server!.close(r));
    }
    server = undefined;
  });

  const cfg = (url: string) => ({ url, username: "owner", password: "s3cret-pass" });

  it("sends an authenticated Depth:1 REPORT to the collection and returns the calendar-data", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(sabre(ICS_A));
    });
    const out = await fetchCalendarData(cfg(url), { start, end }, { expand: true });
    expect(out).toEqual([ICS_A]);
    expect(seen!.method).toBe("REPORT");
    expect(seen!.url).toBe("/remote.php/dav/calendars/owner/main");
    expect(seen!.headers.depth).toBe("1");
    expect(seen!.headers.authorization).toBe(`Basic ${Buffer.from("owner:s3cret-pass").toString("base64")}`);
    expect(seen!.headers["content-type"]).toMatch(/xml/);
    expect(seen!.body).toContain("<C:expand");
  });

  it.each([401, 403, 404, 500, 503])("HTTP %i raises a typed http error carrying the status and no body/credentials", async (status) => {
    const url = await serve((_req, res) => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("SECRET-RESPONSE-BODY owner:s3cret-pass");
    });
    try {
      await fetchCalendarData(cfg(url), { start, end }, { expand: false });
    } catch (err) {
      expect(err).toBeInstanceOf(CalDavFetchError);
      const e = err as CalDavFetchError;
      expect(e.kind).toBe("http");
      expect(e.status).toBe(status);
      expect(`${e.message} ${JSON.stringify(e)}`).not.toMatch(/SECRET-RESPONSE-BODY|s3cret-pass/);
      return;
    }
    throw new Error("expected a throw");
  });

  it("a 200 with non-multistatus content is a malformed response", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>login</html>");
    });
    await expect(fetchCalendarData(cfg(url), { start, end }, { expand: false })).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("a refused connection is a network error", async () => {
    const url = await serve((_req, res) => res.end());
    await new Promise((r) => server!.close(r));
    server = undefined;
    await expect(fetchCalendarData(cfg(url), { start, end }, { expand: false })).rejects.toMatchObject({ kind: "network" });
  });

  it("a server that never answers is cut by the timeout", async () => {
    const url = await serve(() => {
      /* never respond */
    });
    await expect(fetchCalendarData(cfg(url), { start, end }, { expand: false, timeoutMs: 150 })).rejects.toMatchObject({ kind: "network" });
  });
});
