import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fp from "fastify-plugin";

const schedule = vi.hoisted(() => vi.fn());
const runCalDavSync = vi.hoisted(() => vi.fn());
vi.mock("node-cron", () => ({ default: { schedule } }));
vi.mock("../../modules/calendar-sync/calendar-sync.service", () => ({ runCalDavSync }));

import calendarSyncPlugin, { calendarSyncEnabled } from "../calendarSync";

describe("calendarSyncEnabled", () => {
  it("is on by default (production images do not set NODE_ENV)", () => {
    expect(calendarSyncEnabled({})).toBe(true);
    expect(calendarSyncEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(calendarSyncEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  it("is off when CALDAV_SYNC_ENABLED is the string 'false' (case-insensitive)", () => {
    expect(calendarSyncEnabled({ CALDAV_SYNC_ENABLED: "false" })).toBe(false);
    expect(calendarSyncEnabled({ CALDAV_SYNC_ENABLED: "FALSE" })).toBe(false);
    expect(calendarSyncEnabled({ CALDAV_SYNC_ENABLED: "true" })).toBe(true);
  });

  it("is always off under NODE_ENV=test, even if explicitly enabled (a test boot never reads the real calendar)", () => {
    expect(calendarSyncEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(calendarSyncEnabled({ NODE_ENV: "test", CALDAV_SYNC_ENABLED: "true" })).toBe(false);
  });
});

describe("package.json dev scripts", () => {
  const scripts = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")).scripts as Record<string, string>;

  it.each(["dev", "dev:once"])("%s defaults CALDAV_SYNC_ENABLED to false but lets the caller override it", (name) => {
    expect(scripts[name]).toContain("CALDAV_SYNC_ENABLED=${CALDAV_SYNC_ENABLED:-false}");
  });

  it("start (production) does not force it off", () => {
    expect(scripts.start).not.toContain("CALDAV_SYNC_ENABLED");
  });
});

describe("calendarSync plugin", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, CALDAV_SYNC_ENABLED: process.env.CALDAV_SYNC_ENABLED };
  const stop = vi.fn();

  beforeEach(() => {
    schedule.mockReset();
    schedule.mockReturnValue({ stop });
    stop.mockReset();
    runCalDavSync.mockReset();
    runCalDavSync.mockResolvedValue({ fetched: 0, busyIntervals: 0, inserted: 0, updated: 0, deleted: 0, failed: false });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function boot() {
    const app = Fastify();
    await app.register(fp(async () => undefined, { name: "postgres" })); // the plugin declares it as a dependency
    await app.register(calendarSyncPlugin);
    await app.ready();
    return app;
  }

  it("under NODE_ENV=test it schedules nothing and never syncs", async () => {
    process.env.NODE_ENV = "test";
    process.env.CALDAV_SYNC_ENABLED = "true";
    const app = await boot();
    expect(schedule).not.toHaveBeenCalled();
    expect(runCalDavSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("when enabled: runs once immediately on boot and schedules every 5 minutes, stopped on close", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CALDAV_SYNC_ENABLED;
    const app = await boot();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toBe("*/5 * * * *");
    await vi.waitFor(() => expect(runCalDavSync).toHaveBeenCalledTimes(1));
    expect(runCalDavSync.mock.calls[0][1]).toMatchObject({ trigger: "cron" });
    await app.close();
    expect(stop).toHaveBeenCalled();
  });

  it("a scheduled tick runs a pass, and a tick while a pass is still running is skipped (no overlap)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CALDAV_SYNC_ENABLED;
    let release!: () => void;
    runCalDavSync.mockImplementation(() => new Promise((r) => (release = () => r({ failed: false }))));
    const app = await boot();
    await vi.waitFor(() => expect(runCalDavSync).toHaveBeenCalledTimes(1)); // the boot run, still pending
    const tick = schedule.mock.calls[0][1] as () => void;
    tick();
    tick();
    expect(runCalDavSync).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(runCalDavSync).toHaveBeenCalledTimes(1));
    runCalDavSync.mockResolvedValue({ failed: false });
    await new Promise((r) => setTimeout(r, 10));
    tick();
    await vi.waitFor(() => expect(runCalDavSync).toHaveBeenCalledTimes(2));
    await app.close();
  });

  it("when disabled by CALDAV_SYNC_ENABLED=false it schedules nothing", async () => {
    process.env.NODE_ENV = "production";
    process.env.CALDAV_SYNC_ENABLED = "false";
    const app = await boot();
    expect(schedule).not.toHaveBeenCalled();
    expect(runCalDavSync).not.toHaveBeenCalled();
    await app.close();
  });
});
