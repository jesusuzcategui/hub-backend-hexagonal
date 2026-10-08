// DB-backed tests for the Nextcloud busy-time sync. They NEVER touch DATABASE_URL: they only run when
// CALSYNC_IT_DATABASE_URL points at a throwaway database whose name ends with _it. The real Nextcloud is never
// contacted: CALDAV_URL is pointed (at run time) at a fake CalDAV server on 127.0.0.1 that answers canned
// multistatus bodies. Mailer and the CalDAV write client are mocks; no email is sent.
//   CALSYNC_IT_DATABASE_URL=postgres://postgres:x@localhost:5433/hub_cal_it pnpm exec vitest run --no-file-parallelism calendar-sync.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { and, eq, inArray } from "drizzle-orm";
import { createDrizzle } from "../../../db";
import { env } from "../../../config/env";
import { accounts } from "../../../db/schema/users";
import { products } from "../../../db/schema/ecommerce";
import { blockedSlots, bookings, bookingSeries, classCredits, mentoringRequests, weeklySlots } from "../../../db/schema/scheduling";
import { AppError, appErrorBody } from "../../../lib/errors";
import { scheduleRoutes } from "../../schedule/schedule.routes";
import { adminRoutes } from "../../admin/admin.routes";
import { portfolioRoutes } from "../../portfolio/portfolio.routes";
import { getAvailableSlots } from "../../schedule/schedule.service";
import { previewSeries } from "../../schedule/series.service";
import { createMentoringRequest, getPublicSlots } from "../../portfolio/portfolio.service";
import { runCalDavSync } from "../calendar-sync.service";

const DB_URL = process.env.CALSYNC_IT_DATABASE_URL;
const dbName = DB_URL ? new URL(DB_URL).pathname.slice(1) : "";
if (DB_URL && !/_it$/.test(dbName)) {
  throw new Error(`Refusing to run calendar sync integration tests against database "${dbName}"`);
}

const H = 3_600_000;
const DAY = 24 * H;
const TAG = `calit_${Date.now()}`;
const SECRET_TITLE = "TOP-SECRET-DENTIST-7731";
const PASSWORD = "caldav-it-password-9f3a";
const ERROR_BODY = "SERVER-ERROR-BODY-5521";

// ---------- dates (Bogota) ----------
function bogotaDate(offsetDays: number): string {
  return new Date(Date.now() - 5 * H + offsetDays * DAY).toISOString().slice(0, 10);
}
/** First date (YYYY-MM-DD, Bogota) with the given weekday (0=Sun) at least `minAhead` days ahead. */
function nextWeekday(dow: number, minAhead = 3): string {
  for (let d = minAhead; d < minAhead + 8; d++) {
    const date = bogotaDate(d);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === dow) return date;
  }
  throw new Error("unreachable");
}
const compact = (isoDate: string) => isoDate.replace(/-/g, "");
const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ---------- iCalendar fixtures ----------
const vcal = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//it//EN", ...events, "END:VCALENDAR"].join("\r\n");
function timed(uid: string, isoDate: string, from: string, to: string, summary = SECRET_TITLE, extra: string[] = []): string {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART;TZID=America/Bogota:${compact(isoDate)}T${from}00`,
    `DTEND;TZID=America/Bogota:${compact(isoDate)}T${to}00`,
    `SUMMARY:${summary}`,
    ...extra,
    "END:VEVENT",
  ].join("\r\n");
}
function allDay(uid: string, isoDate: string, days = 1, summary = SECRET_TITLE): string {
  return ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${compact(isoDate)}`, `DTEND;VALUE=DATE:${compact(addDays(isoDate, days))}`, `SUMMARY:${summary}`, "END:VEVENT"].join("\r\n");
}

// ---------- fake CalDAV server ----------
type Mode = "ok" | "http500" | "http401" | "html200";
class FakeCalDav {
  server!: http.Server;
  url = "";
  mode: Mode = "ok";
  resources: string[] = [];
  requests: Array<{ method?: string; auth?: string; body: string }> = [];

  async start() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ method: req.method, auth: req.headers.authorization, body });
        if (this.mode === "http500" || this.mode === "http401") {
          res.writeHead(this.mode === "http500" ? 500 : 401, { "Content-Type": "text/plain" });
          return res.end(ERROR_BODY);
        }
        if (this.mode === "html200") {
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end("<html>login</html>");
        }
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
        const xml =
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
          this.resources
            .map((r, i) => `<d:response><d:href>/cal/${i}.ics</d:href><d:propstat><d:prop><cal:calendar-data>${esc(r)}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
            .join("") +
          `</d:multistatus>`;
        res.writeHead(207, { "Content-Type": "application/xml" });
        res.end(xml);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/remote.php/dav/calendars/owner/main`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
  reset() {
    this.mode = "ok";
    this.resources = [];
    this.requests = [];
  }
}

describe.skipIf(!DB_URL)("calendar sync (throwaway DB + fake CalDAV)", () => {
  let pool: Pool;
  let db: ReturnType<typeof createDrizzle>;
  let fastify: FastifyInstance;
  let logs: string[];
  const fake = new FakeCalDav();
  const teacherId = env.mentoring.teacherId;
  let createdTeacher = false;
  let productId: string;
  let deactivatedSlotIds: string[] = [];
  const ownSlotIds: string[] = [];
  const accountIds: string[] = [];
  const manualBlockIds: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  let seq = 0;

  // The Thursday used by most tests, and the weekly slot that covers 06:00-08:00 on Thursdays.
  const thu = nextWeekday(4);
  let thuSlotId: string;
  let monSlotId: string;
  const thuSlotKey = (hhmm: string, date = thu) => `${thuSlotId}_${compact(date)}_${hhmm}`;

  const admin = { "x-user": "", "x-role": "admin" } as Record<string, string>;
  const asUser = (id: string) => ({ "x-user": id, "x-role": "user" });

  const sync = (opts: { dryRun?: boolean } = {}) => runCalDavSync(fastify, { ...opts, trigger: "manual" });
  const caldavRows = () => db.select().from(blockedSlots).where(eq(blockedSlots.source, "caldav"));
  const slotIds = async () => (await getAvailableSlots(fastify)).map((s) => s.id);

  async function newStudent() {
    const n = seq++;
    const [a] = await db
      .insert(accounts)
      .values({ email: `${TAG}_s${n}@hub.test`, displayName: `IT Student ${n}`, role: "user", locale: "es" })
      .returning({ id: accounts.id });
    accountIds.push(a.id);
    return a.id;
  }
  async function giveCredits(userId: string, total = 10) {
    await db.insert(classCredits).values({ userId, productId, totalCredits: total, usedCredits: 0, expiresAt: new Date(Date.now() + 60 * DAY) });
  }
  async function newSlot(tid: string, dayOfWeek: number, startTime: string, endTime: string) {
    const [s] = await db.insert(weeklySlots).values({ teacherId: tid, dayOfWeek, startTime, endTime, isActive: true }).returning({ id: weeklySlots.id });
    ownSlotIds.push(s.id);
    return s.id;
  }

  beforeAll(async () => {
    for (const k of ["CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD", "MENTORING_TEACHER_ID", "CALDAV_ALL_DAY_BLOCKS", "CALDAV_SYNC_HORIZON_WEEKS", "CALDAV_SYNC_EXPAND"]) savedEnv[k] = process.env[k];
    await fake.start();
    process.env.CALDAV_URL = fake.url;
    process.env.CALDAV_USERNAME = "owner";
    process.env.CALDAV_PASSWORD = PASSWORD;
    process.env.MENTORING_TEACHER_ID = teacherId;

    pool = new Pool({ connectionString: DB_URL });
    db = createDrizzle(pool);

    logs = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    fastify = Fastify({ logger: { level: "debug", stream } });
    fastify.decorate("drizzle", db);
    fastify.decorate("mailer", { sendMail: vi.fn().mockResolvedValue({}) } as any);
    fastify.decorate("caldav", { createEvent: vi.fn().mockResolvedValue(undefined), deleteEvent: vi.fn().mockResolvedValue(undefined) } as any);
    fastify.decorate("authenticate", async (req: any) => {
      req.user = { sub: req.headers["x-user"], role: req.headers["x-role"] ?? "user" };
    });
    fastify.setErrorHandler((error: any, _req, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(appErrorBody(error));
      return reply.status(500).send({ error: error.message });
    });
    await fastify.register(scheduleRoutes);
    await fastify.register(adminRoutes);
    await fastify.register(portfolioRoutes);
    await fastify.ready();

    // The mentoring teacher must exist (blocked_slots.teacher_id is a foreign key).
    const existing = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, teacherId));
    if (!existing.length) {
      await db.insert(accounts).values({ id: teacherId, email: `${TAG}_teacher@hub.test`, displayName: "IT Teacher", role: "admin" });
      createdTeacher = true;
    }
    admin["x-user"] = teacherId;

    // Independent of whatever weekly slots the database was seeded with.
    const active = await db.select({ id: weeklySlots.id }).from(weeklySlots).where(eq(weeklySlots.isActive, true));
    deactivatedSlotIds = active.map((s) => s.id);
    if (deactivatedSlotIds.length) await db.update(weeklySlots).set({ isActive: false }).where(inArray(weeklySlots.id, deactivatedSlotIds));
    thuSlotId = await newSlot(teacherId, 4, "06:00", "08:00"); // Thursday 06:00 + 07:00
    monSlotId = await newSlot(teacherId, 1, "06:00", "08:00");

    const [p] = await db
      .insert(products)
      .values({ externalId: `${TAG}_p`, contentType: "nodus_product", slug: `${TAG}-p`, name: "IT Plan", metadata: {} })
      .returning({ id: products.id });
    productId = p.id;
  });

  beforeEach(async () => {
    fake.reset();
    process.env.CALDAV_URL = fake.url;
    delete process.env.CALDAV_ALL_DAY_BLOCKS;
    delete process.env.CALDAV_SYNC_HORIZON_WEEKS;
    delete process.env.CALDAV_SYNC_EXPAND;
    await db.delete(blockedSlots).where(eq(blockedSlots.source, "caldav"));
    if (manualBlockIds.length) await db.delete(blockedSlots).where(inArray(blockedSlots.id, manualBlockIds));
    manualBlockIds.length = 0;
    await db.delete(mentoringRequests).where(eq(mentoringRequests.email, `${TAG}@mentor.test`));
    if (accountIds.length) {
      await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
      await db.delete(bookingSeries).where(inArray(bookingSeries.studentId, accountIds));
      await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    }
    logs.length = 0;
  });

  afterEach(() => {
    delete process.env.CALDAV_ALL_DAY_BLOCKS;
  });

  afterAll(async () => {
    if (!pool) return;
    await db.delete(blockedSlots).where(eq(blockedSlots.source, "caldav"));
    if (manualBlockIds.length) await db.delete(blockedSlots).where(inArray(blockedSlots.id, manualBlockIds));
    await db.delete(mentoringRequests).where(eq(mentoringRequests.email, `${TAG}@mentor.test`));
    if (accountIds.length) {
      await db.delete(bookings).where(inArray(bookings.studentId, accountIds));
      await db.delete(bookingSeries).where(inArray(bookingSeries.studentId, accountIds));
      await db.delete(classCredits).where(inArray(classCredits.userId, accountIds));
    }
    await db.delete(weeklySlots).where(inArray(weeklySlots.id, ownSlotIds));
    if (deactivatedSlotIds.length) await db.update(weeklySlots).set({ isActive: true }).where(inArray(weeklySlots.id, deactivatedSlotIds));
    await db.delete(products).where(eq(products.id, productId));
    if (accountIds.length) await db.delete(accounts).where(inArray(accounts.id, accountIds));
    if (createdTeacher) await db.delete(accounts).where(eq(accounts.id, teacherId));
    await fastify.close();
    await pool.end();
    await fake.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ------------------------------------------------------------------------------------------
  describe("the Thursday 6:00-7:00 'Clase de ingles' scenario", () => {
    it("sync mirrors the event into blocked_slots as a caldav row", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "Clase de ingles"))];
      const out = await sync();
      expect(out).toMatchObject({ fetched: 1, busyIntervals: 1, inserted: 1, updated: 0, deleted: 0, skippedPlatformEvents: 0, skippedTransparent: 0, skippedCancelled: 0, failed: false });

      const rows = await caldavRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "caldav", reason: "nextcloud", teacherId, externalSummary: "Clase de ingles" });
      expect(rows[0].startsAt.toISOString()).toBe(`${thu}T11:00:00.000Z`);
      expect(rows[0].endsAt.toISOString()).toBe(`${thu}T12:00:00.000Z`);
      expect(rows[0].externalKey).toBe(`owner-evt-1|${thu}T11:00:00.000Z`);
      expect(rows[0].syncedAt).toBeInstanceOf(Date);
      // Basic auth REPORT to the configured collection, with the calendar-query body
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0].method).toBe("REPORT");
      expect(fake.requests[0].auth).toBe(`Basic ${Buffer.from(`owner:${PASSWORD}`).toString("base64")}`);
      expect(fake.requests[0].body).toContain("calendar-query");
    });

    it("the student booking drawer (getAvailableSlots) loses the 06:00 slot but keeps 07:00", async () => {
      expect(await slotIds()).toContain(thuSlotKey("0600"));
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "Clase de ingles"))];
      await sync();
      const ids = await slotIds();
      expect(ids).not.toContain(thuSlotKey("0600"));
      expect(ids).toContain(thuSlotKey("0700"));
    });

    it("a series preview marks that occurrence as blocked", async () => {
      const student = await newStudent();
      await giveCredits(student);
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      const out = await previewSeries(fastify, { studentId: student, rule: { pattern: [{ weekday: 4, time: "06:00" }], intervalWeeks: 1, startDate: thu, occurrences: 2 } });
      const first = out.occurrences.find((o: any) => o.date === thu || String(o.startsAt).startsWith(`${thu}T11:00`));
      expect(first).toBeDefined();
      expect(first!.status).toBe("blocked");
      expect(out.occurrences.filter((o: any) => o.status === "ok")).toHaveLength(1);
    });

    it("booking that slot is rejected with 409 SLOT_BLOCKED", async () => {
      const student = await newStudent();
      await giveCredits(student);
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      const res = await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(student), payload: { slotId: thuSlotKey("0600") } });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toMatchObject({ code: "SLOT_BLOCKED", message: "Slot is blocked" });
      expect(await db.select().from(bookings).where(eq(bookings.studentId, student))).toHaveLength(0);
      // the neighbouring free hour still books
      const ok = await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(student), payload: { slotId: thuSlotKey("0700") } });
      expect(ok.statusCode).toBe(201);
    });

    it("removing the event on the server deletes the row on the next sync and reopens the slot", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      expect(await caldavRows()).toHaveLength(1);
      fake.resources = [];
      const out = await sync();
      expect(out).toMatchObject({ deleted: 1, inserted: 0, failed: false });
      expect(await caldavRows()).toHaveLength(0);
      expect(await slotIds()).toContain(thuSlotKey("0600"));
    });

    it("moving the event updates the row instead of duplicating it", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      fake.resources = [vcal(timed("owner-evt-1", thu, "0700", "0800"))];
      const out = await sync();
      // a non-recurring event is keyed by UID + start, so a moved event is one delete + one insert
      expect(out).toMatchObject({ inserted: 1, deleted: 1, failed: false });
      const rows = await caldavRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].startsAt.toISOString()).toBe(`${thu}T12:00:00.000Z`);
    });

    it("a second identical sync changes nothing (stable keys)", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"), allDay("owner-evt-2", addDays(thu, 3)))];
      await sync();
      const before = await caldavRows();
      const out = await sync();
      expect(out).toMatchObject({ inserted: 0, updated: 0, deleted: 0, busyIntervals: 2 });
      const after = await caldavRows();
      expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    });

    it("renaming the event updates the stored title in place", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "Old"))];
      await sync();
      const [before] = await caldavRows();
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "New"))];
      expect(await sync()).toMatchObject({ inserted: 0, updated: 1, deleted: 0 });
      const [after] = await caldavRows();
      expect(after.id).toBe(before.id);
      expect(after.externalSummary).toBe("New");
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("a failing server never un-blocks anything", () => {
    it.each<[string, Mode, string]>([
      ["HTTP 500", "http500", "http"],
      ["HTTP 401 (bad credentials)", "http401", "http"],
      ["a 200 login page (malformed XML)", "html200", "malformed_response"],
    ])("%s keeps the last known good rows and returns a failed summary", async (_n, mode, kind) => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      const before = await caldavRows();
      expect(before).toHaveLength(1);

      fake.mode = mode;
      const out = await sync();
      expect(out.failed).toBe(true);
      expect(out.error).toMatchObject({ kind });
      expect(out).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
      expect((await caldavRows()).map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect(await slotIds()).not.toContain(thuSlotKey("0600"));
    });

    it("an unreachable server (connection refused) is a failed sync too", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      process.env.CALDAV_URL = "http://127.0.0.1:1/never";
      const out = await sync();
      expect(out.failed).toBe(true);
      expect(out.error).toMatchObject({ kind: "network" });
      expect(await caldavRows()).toHaveLength(1);
    });

    it("failures are logged without the response body, credentials or titles", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      fake.mode = "http500";
      await sync();
      fake.mode = "http401";
      await sync();
      const all = logs.join("\n");
      expect(all).toContain("calendar-sync");
      expect(all).not.toContain(ERROR_BODY);
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain(Buffer.from(`owner:${PASSWORD}`).toString("base64"));
      expect(all).not.toContain(SECRET_TITLE);
    });

    it("a successful sync does not log titles either", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      expect(logs.join("\n")).not.toContain(SECRET_TITLE);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("all-day events", () => {
    it("block the whole Bogota day, every slot of it", async () => {
      const afternoon = await newSlot(teacherId, 4, "15:00", "16:00");
      fake.resources = [vcal(allDay("vacation", thu))];
      const out = await sync();
      expect(out).toMatchObject({ inserted: 1, failed: false });
      const ids = await slotIds();
      expect(ids).not.toContain(thuSlotKey("0600"));
      expect(ids).not.toContain(thuSlotKey("0700"));
      expect(ids).not.toContain(`${afternoon}_${compact(thu)}_1500`);
      // the following Thursday is untouched
      expect(ids).toContain(thuSlotKey("0600", addDays(thu, 7)));
    });

    it("a multi-day event blocks every day it covers", async () => {
      const mon = nextWeekday(1);
      fake.resources = [vcal(allDay("trip", mon, 3))]; // Mon, Tue, Wed
      await sync();
      expect(await slotIds()).not.toContain(`${monSlotId}_${compact(mon)}_0600`);
      expect(await slotIds()).toContain(`${monSlotId}_${compact(addDays(mon, 7))}_0600`);
    });

    it("CALDAV_ALL_DAY_BLOCKS=false turns it off: nothing is blocked and previously mirrored rows go away", async () => {
      fake.resources = [vcal(allDay("vacation", thu))];
      await sync();
      expect(await caldavRows()).toHaveLength(1);

      process.env.CALDAV_ALL_DAY_BLOCKS = "false";
      const out = await sync();
      expect(out).toMatchObject({ inserted: 0, deleted: 1, busyIntervals: 0, skippedAllDay: 1 });
      expect(await caldavRows()).toHaveLength(0);
      expect(await slotIds()).toContain(thuSlotKey("0600"));
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("what must not block", () => {
    it("platform-written events (<uuid>@vanjex.dev), transparent and cancelled events are skipped and counted", async () => {
      fake.resources = [
        vcal(timed(`${randomUUID()}@vanjex.dev`, thu, "0700", "0800", "Clase - Plan - Ana")),
        vcal(timed("free-time", thu, "0600", "0700", "Free", ["TRANSP:TRANSPARENT"])),
        vcal(timed("cancelled", thu, "0600", "0700", "Cancelled", ["STATUS:CANCELLED"])),
      ];
      const out = await sync();
      expect(out).toMatchObject({ fetched: 3, busyIntervals: 0, inserted: 0, skippedPlatformEvents: 1, skippedTransparent: 1, skippedCancelled: 1, failed: false });
      expect(await caldavRows()).toHaveLength(0);
      const ids = await slotIds();
      expect(ids).toContain(thuSlotKey("0600"));
      expect(ids).toContain(thuSlotKey("0700"));
    });

    it("an event the platform itself wrote for a real booking does not block that booking's own hour", async () => {
      const student = await newStudent();
      await giveCredits(student);
      const res = await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(student), payload: { slotId: thuSlotKey("0700") } });
      expect(res.statusCode).toBe(201);
      const { bookingId } = JSON.parse(res.body).data;
      fake.resources = [vcal(timed(`${bookingId}@vanjex.dev`, thu, "0700", "0800", "Clase - IT Plan - IT Student"))];
      const out = await sync();
      expect(out).toMatchObject({ skippedPlatformEvents: 1, inserted: 0 });
      expect(await caldavRows()).toHaveLength(0);
    });

    it("a weekly recurring event is expanded: EXDATE and cancelled overrides leave their slot open", async () => {
      const second = addDays(thu, 7);
      const third = addDays(thu, 14);
      const master = timed("weekly", thu, "0600", "0700", "Weekly", ["RRULE:FREQ=WEEKLY;COUNT=3", `EXDATE;TZID=America/Bogota:${compact(second)}T060000`]);
      fake.resources = [vcal(master)];
      const out = await sync();
      expect(out.busyIntervals).toBe(2);
      const ids = await slotIds();
      expect(ids).not.toContain(thuSlotKey("0600", thu));
      expect(ids).toContain(thuSlotKey("0600", second));
      expect(ids).not.toContain(thuSlotKey("0600", third));
      // stable: nothing changes on the next pass
      expect(await sync()).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("manual blocks", () => {
    it("are never touched by the sync, even when the calendar is empty or has the same time", async () => {
      const [m] = await db
        .insert(blockedSlots)
        .values({ teacherId, startsAt: new Date(`${thu}T11:00:00Z`), endsAt: new Date(`${thu}T12:00:00Z`), reason: "manual vacation" })
        .returning();
      manualBlockIds.push(m.id);
      expect(m.source).toBe("manual");

      fake.resources = [];
      expect(await sync()).toMatchObject({ deleted: 0, inserted: 0 });
      fake.resources = [vcal(timed("same-time", thu, "0600", "0700"))];
      expect(await sync()).toMatchObject({ inserted: 1, deleted: 0 });
      fake.resources = [];
      expect(await sync()).toMatchObject({ deleted: 1 });

      const [still] = await db.select().from(blockedSlots).where(eq(blockedSlots.id, m.id));
      expect(still).toMatchObject({ source: "manual", reason: "manual vacation", externalKey: null, externalSummary: null, syncedAt: null });
      expect(await slotIds()).not.toContain(thuSlotKey("0600"));
    });

    it("the admin API still creates source=manual rows", async () => {
      const res = await fastify.inject({
        method: "POST",
        url: "/admin/blocked-slots",
        headers: admin,
        payload: { startsAt: `${thu}T11:00:00Z`, endsAt: `${thu}T12:00:00Z`, reason: "dentist" },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body).data;
      manualBlockIds.push(created.id);
      expect(created).toMatchObject({ source: "manual", reason: "dentist" });
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("public mentoring slots", () => {
    const mentoringBody = (slotId: string) => ({
      slotId,
      name: "Ment Or",
      email: `${TAG}@mentor.test`,
      whatsapp: "+573001112233",
      type: "wordpress" as const,
      locale: "es" as const,
    });

    it("exclude a caldav block (the gap that existed before: blocked_slots were ignored)", async () => {
      expect((await getPublicSlots(fastify)).map((s) => s.id)).toContain(thuSlotKey("0600"));
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      const ids = (await getPublicSlots(fastify)).map((s) => s.id);
      expect(ids).not.toContain(thuSlotKey("0600"));
      expect(ids).toContain(thuSlotKey("0700"));
    });

    it("exclude a manual block too", async () => {
      const [m] = await db.insert(blockedSlots).values({ teacherId, startsAt: new Date(`${thu}T12:00:00Z`), endsAt: new Date(`${thu}T13:00:00Z`), reason: "manual" }).returning();
      manualBlockIds.push(m.id);
      expect((await getPublicSlots(fastify)).map((s) => s.id)).not.toContain(thuSlotKey("0700"));
    });

    it("GET /public/slots does not leak the event title", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      const res = await fastify.inject({ method: "GET", url: "/public/slots" });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SECRET_TITLE);
      expect(JSON.parse(res.body).data.map((s: any) => s.id)).not.toContain(thuSlotKey("0600"));
    });

    it("a direct request for a blocked slot is rejected as blocked, nothing is stored", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      await expect(createMentoringRequest(fastify, mentoringBody(thuSlotKey("0600")))).rejects.toThrow(/blocked/i);
      expect(await db.select().from(mentoringRequests).where(eq(mentoringRequests.email, `${TAG}@mentor.test`))).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("dry run", () => {
    it("writes nothing and returns the intervals it would write with masked titles", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "Clase de ingles"), allDay("vacation", addDays(thu, 2), 1, "Vacaciones"))];
      const out = await sync({ dryRun: true });
      expect(out.dryRun).toBe(true);
      expect(out).toMatchObject({ fetched: 1, busyIntervals: 2, inserted: 2, updated: 0, deleted: 0, failed: false });
      expect(out.intervals).toEqual([
        { startsAt: `${thu}T11:00:00.000Z`, endsAt: `${thu}T12:00:00.000Z`, allDay: false, summary: "Cl***" },
        { startsAt: `${addDays(thu, 2)}T05:00:00.000Z`, endsAt: `${addDays(thu, 3)}T05:00:00.000Z`, allDay: true, summary: "Va***" },
      ]);
      expect(JSON.stringify(out)).not.toContain("Clase de ingles");
      expect(JSON.stringify(out)).not.toContain("Vacaciones");
      expect(await caldavRows()).toHaveLength(0);
      expect(await slotIds()).toContain(thuSlotKey("0600"));
    });

    it("on top of existing rows it reports what it would delete, and still deletes nothing", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      fake.resources = [];
      const out = await sync({ dryRun: true });
      expect(out).toMatchObject({ deleted: 1, inserted: 0, dryRun: true });
      expect(await caldavRows()).toHaveLength(1);
    });

    it("does not overwrite the status of the last real run", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      await sync({ dryRun: true });
      const res = await fastify.inject({ method: "GET", url: "/admin/calendar-sync/status", headers: admin });
      const body = JSON.parse(res.body).data;
      expect(body.lastRun.dryRun).toBe(false);
      expect(body.lastDryRun.dryRun).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("admin endpoints", () => {
    it("POST /admin/calendar-sync/run returns the summary; dryRun returns masked intervals", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "Clase de ingles"))];
      const dry = await fastify.inject({ method: "POST", url: "/admin/calendar-sync/run", headers: admin, payload: { dryRun: true } });
      expect(dry.statusCode).toBe(200);
      const dryBody = JSON.parse(dry.body).data;
      expect(dryBody).toMatchObject({ dryRun: true, busyIntervals: 1, inserted: 1, failed: false });
      expect(dryBody.intervals[0].summary).toBe("Cl***");
      expect(await caldavRows()).toHaveLength(0);

      const real = await fastify.inject({ method: "POST", url: "/admin/calendar-sync/run", headers: admin, payload: {} });
      expect(real.statusCode).toBe(200);
      expect(JSON.parse(real.body).data).toMatchObject({ dryRun: false, inserted: 1, failed: false });
      expect(await caldavRows()).toHaveLength(1);
    });

    it("POST run with no body at all works and a failing server answers 200 with failed:true (not a 5xx)", async () => {
      fake.mode = "http500";
      const res = await fastify.inject({ method: "POST", url: "/admin/calendar-sync/run", headers: admin });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data).toMatchObject({ failed: true, error: { kind: "http", status: 500 } });
      expect(res.body).not.toContain(ERROR_BODY);
    });

    it("rejects a non-boolean dryRun", async () => {
      const res = await fastify.inject({ method: "POST", url: "/admin/calendar-sync/run", headers: admin, payload: { dryRun: "yes" } });
      expect(res.statusCode).toBe(400);
    });

    it("GET /admin/calendar-sync/status returns last run, counters and the caldav row count", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      const res = await fastify.inject({ method: "GET", url: "/admin/calendar-sync/status", headers: admin });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body).data;
      expect(body.caldavRows).toBe(1);
      expect(body.lastRun).toMatchObject({ trigger: "manual", dryRun: false, failed: false, summary: { inserted: 1, busyIntervals: 1 } });
      expect(new Date(body.lastRun.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(typeof body.enabled).toBe("boolean");
      expect(body.horizonWeeks).toBe(16);
    });

    it("status after a failed run reports it while the rows stay", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      fake.mode = "http401";
      await sync();
      const body = JSON.parse((await fastify.inject({ method: "GET", url: "/admin/calendar-sync/status", headers: admin })).body).data;
      expect(body.lastRun).toMatchObject({ failed: true, summary: { error: { kind: "http", status: 401 } } });
      expect(body.caldavRows).toBe(1);
    });

    it("GET /admin/calendar-sync/conflicts lists CONFIRMED bookings inside a new block and never cancels them", async () => {
      const student = await newStudent();
      await giveCredits(student);
      const booked = await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(student), payload: { slotId: thuSlotKey("0600") } });
      expect(booked.statusCode).toBe(201);
      const { bookingId } = JSON.parse(booked.body).data;
      // another student, other hour, not in the block
      const other = await newStudent();
      await giveCredits(other);
      const ok = await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(other), payload: { slotId: thuSlotKey("0700") } });
      expect(ok.statusCode).toBe(201);

      const none = JSON.parse((await fastify.inject({ method: "GET", url: "/admin/calendar-sync/conflicts", headers: admin })).body).data;
      expect(none).toEqual([]);

      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "Clase de ingles"))];
      await sync();
      const res = await fastify.inject({ method: "GET", url: "/admin/calendar-sync/conflicts", headers: admin });
      expect(res.statusCode).toBe(200);
      const conflicts = JSON.parse(res.body).data;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        bookingId,
        studentId: student,
        startsAt: `${thu}T11:00:00.000Z`,
        endsAt: `${thu}T12:00:00.000Z`,
        status: "confirmed",
        block: { startsAt: `${thu}T11:00:00.000Z`, endsAt: `${thu}T12:00:00.000Z`, summary: "Clase de ingles" },
      });
      const [row] = await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, bookingId));
      expect(row.status).toBe("confirmed");
    });

    it("conflicts ignore manual blocks and cancelled bookings", async () => {
      const student = await newStudent();
      await giveCredits(student);
      const booked = await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(student), payload: { slotId: thuSlotKey("0600") } });
      const { bookingId } = JSON.parse(booked.body).data;
      const [m] = await db.insert(blockedSlots).values({ teacherId, startsAt: new Date(`${thu}T11:00:00Z`), endsAt: new Date(`${thu}T12:00:00Z`), reason: "manual" }).returning();
      manualBlockIds.push(m.id);
      expect(JSON.parse((await fastify.inject({ method: "GET", url: "/admin/calendar-sync/conflicts", headers: admin })).body).data).toEqual([]);

      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, bookingId));
      expect(JSON.parse((await fastify.inject({ method: "GET", url: "/admin/calendar-sync/conflicts", headers: admin })).body).data).toEqual([]);
    });

    it.each([
      ["POST", "/admin/calendar-sync/run"],
      ["GET", "/admin/calendar-sync/status"],
      ["GET", "/admin/calendar-sync/conflicts"],
    ])("%s %s is admin-only", async (method, url) => {
      const res = await fastify.inject({ method: method as "GET" | "POST", url, headers: asUser(randomUUID()), payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(403);
    });

    it("the admin blocked-slots list exposes source and the title, for both kinds of row", async () => {
      const [m] = await db.insert(blockedSlots).values({ teacherId, startsAt: new Date(`${thu}T15:00:00Z`), endsAt: new Date(`${thu}T16:00:00Z`), reason: "manual" }).returning();
      manualBlockIds.push(m.id);
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", "Clase de ingles"))];
      await sync();
      const res = await fastify.inject({ method: "GET", url: "/admin/blocked-slots", headers: admin });
      const list = JSON.parse(res.body).data as any[];
      const cal = list.find((b) => b.source === "caldav");
      const man = list.find((b) => b.id === m.id);
      expect(cal).toMatchObject({ source: "caldav", reason: "nextcloud", externalSummary: "Clase de ingles" });
      expect(man).toMatchObject({ source: "manual", externalSummary: null });
    });

    it("an admin cannot delete a mirrored row (it would come back on the next sync)", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"))];
      await sync();
      const [row] = await caldavRows();
      const res = await fastify.inject({ method: "DELETE", url: `/admin/blocked-slots/${row.id}`, headers: admin });
      expect(res.statusCode).toBe(409);
      expect(await caldavRows()).toHaveLength(1);
    });

    it("an admin can still delete a manual row", async () => {
      const [m] = await db.insert(blockedSlots).values({ teacherId, startsAt: new Date(`${thu}T15:00:00Z`), endsAt: new Date(`${thu}T16:00:00Z`), reason: "manual" }).returning();
      const res = await fastify.inject({ method: "DELETE", url: `/admin/blocked-slots/${m.id}`, headers: admin });
      expect(res.statusCode).toBe(200);
      expect(await db.select().from(blockedSlots).where(and(eq(blockedSlots.id, m.id)))).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("privacy: student and public payloads never contain the event title", () => {
    it("none of the student/public endpoints returns it (positive control: the admin list does)", async () => {
      const student = await newStudent();
      await giveCredits(student);
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700", SECRET_TITLE))];
      await sync();
      // book a neighbouring hour so /schedule/my has content as well
      await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(student), payload: { slotId: thuSlotKey("0700") } });

      const bodies: string[] = [];
      for (const url of ["/schedule/slots", "/schedule/credits", "/schedule/my", "/schedule/series", "/public/slots"]) {
        const res = await fastify.inject({ method: "GET", url, headers: asUser(student) });
        expect(res.statusCode).toBe(200);
        bodies.push(res.body);
      }
      const preview = await fastify.inject({
        method: "POST",
        url: "/schedule/series/preview",
        headers: asUser(student),
        payload: { pattern: [{ weekday: 4, time: "06:00" }], intervalWeeks: 1, startDate: thu, occurrences: 3 },
      });
      expect(preview.statusCode).toBe(200);
      bodies.push(preview.body);
      bodies.push(JSON.stringify(await getAvailableSlots(fastify)), JSON.stringify(await getPublicSlots(fastify)));
      for (const b of bodies) expect(b).not.toContain(SECRET_TITLE);

      // a booking attempt on the blocked hour returns an error that does not leak it either
      const rejected = await fastify.inject({ method: "POST", url: "/schedule/book", headers: asUser(student), payload: { slotId: thuSlotKey("0600") } });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.body).not.toContain(SECRET_TITLE);

      const adminList = await fastify.inject({ method: "GET", url: "/admin/blocked-slots", headers: admin });
      expect(adminList.body).toContain(SECRET_TITLE);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("window and horizon", () => {
    it("events beyond CALDAV_SYNC_HORIZON_WEEKS are not mirrored", async () => {
      process.env.CALDAV_SYNC_HORIZON_WEEKS = "2";
      const near = addDays(thu, 0);
      const far = addDays(thu, 7 * 6);
      fake.resources = [vcal(timed("near", near, "0600", "0700")), vcal(timed("far", far, "0600", "0700"))];
      const out = await sync();
      expect(out.busyIntervals).toBe(1);
      expect((await caldavRows()).map((r) => r.externalKey?.split("|")[0])).toEqual(["near"]);
    });

    it("the REPORT asks for the configured window and (by default) server-side expansion", async () => {
      process.env.CALDAV_SYNC_HORIZON_WEEKS = "4";
      const now = new Date("2026-10-05T10:00:00Z");
      await runCalDavSync(fastify, { now, trigger: "manual" });
      expect(fake.requests[0].body).toContain('<C:time-range start="20261005T100000Z" end="20261102T100000Z"/>');
      expect(fake.requests[0].body).toContain("<C:expand");
      process.env.CALDAV_SYNC_EXPAND = "false";
      await runCalDavSync(fastify, { now, trigger: "manual" });
      expect(fake.requests[1].body).not.toContain("<C:expand");
    });

    it("rows of events that already ended are left alone (only the window is reconciled)", async () => {
      const [past] = await db
        .insert(blockedSlots)
        .values({
          teacherId,
          startsAt: new Date(Date.now() - 3 * DAY),
          endsAt: new Date(Date.now() - 3 * DAY + H),
          reason: "nextcloud",
          source: "caldav",
          externalKey: `past|${Date.now()}`,
          externalSummary: "old",
          syncedAt: new Date(),
        })
        .returning();
      fake.resources = [];
      expect(await sync()).toMatchObject({ deleted: 0 });
      expect(await db.select().from(blockedSlots).where(eq(blockedSlots.id, past.id))).toHaveLength(1);
    });

    it("an unparsable event resource is skipped and counted, the others still sync", async () => {
      fake.resources = ["BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken\r\nDTSTART:garbage", vcal(timed("fine", thu, "0600", "0700"))];
      const out = await sync();
      expect(out).toMatchObject({ fetched: 2, busyIntervals: 1, inserted: 1, skippedInvalid: 1, failed: false });
    });

    it("if EVERY resource is unparsable the pass is a failure and keeps the rows", async () => {
      fake.resources = [vcal(timed("fine", thu, "0600", "0700"))];
      await sync();
      fake.resources = ["not an ics", "<html/>"];
      const out = await sync();
      expect(out.failed).toBe(true);
      expect(out.error).toMatchObject({ kind: "malformed_response" });
      expect(await caldavRows()).toHaveLength(1);
    });
  });

  describe("concurrency", () => {
    it("two overlapping passes do not duplicate rows (advisory lock + unique index)", async () => {
      fake.resources = [vcal(timed("owner-evt-1", thu, "0600", "0700"), timed("owner-evt-2", thu, "0700", "0800"))];
      const [a, b] = await Promise.all([sync(), sync()]);
      expect(a.failed || b.failed).toBe(false);
      expect(await caldavRows()).toHaveLength(2);
      expect(a.inserted + b.inserted).toBe(2);
    });
  });
});
