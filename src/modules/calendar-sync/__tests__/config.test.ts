import { describe, it, expect } from "vitest";
import { resolveSyncConfig } from "../config";

const base = {
  CALDAV_URL: "https://cloud.example/remote.php/dav/calendars/owner/main",
  CALDAV_USERNAME: "owner",
  CALDAV_PASSWORD: "pw",
  MENTORING_TEACHER_ID: "11111111-1111-4111-8111-111111111111",
};

describe("resolveSyncConfig", () => {
  it("defaults: 16 weeks, all-day events block, server-side expansion on", () => {
    expect(resolveSyncConfig(base)).toEqual({
      url: base.CALDAV_URL,
      username: "owner",
      password: "pw",
      teacherId: base.MENTORING_TEACHER_ID,
      horizonWeeks: 16,
      allDayBlocks: true,
      expand: true,
    });
  });

  it("reads CALDAV_SYNC_HORIZON_WEEKS", () => {
    expect(resolveSyncConfig({ ...base, CALDAV_SYNC_HORIZON_WEEKS: "8" }).horizonWeeks).toBe(8);
  });

  it.each([["abc"], [""], ["0"], ["-3"], ["2.5"]])("falls back to 16 weeks for the invalid value %j", (v) => {
    expect(resolveSyncConfig({ ...base, CALDAV_SYNC_HORIZON_WEEKS: v }).horizonWeeks).toBe(16);
  });

  it("caps the horizon at 52 weeks", () => {
    expect(resolveSyncConfig({ ...base, CALDAV_SYNC_HORIZON_WEEKS: "500" }).horizonWeeks).toBe(52);
  });

  it("CALDAV_ALL_DAY_BLOCKS=false (any case) turns all-day blocking off; anything else keeps it on", () => {
    expect(resolveSyncConfig({ ...base, CALDAV_ALL_DAY_BLOCKS: "false" }).allDayBlocks).toBe(false);
    expect(resolveSyncConfig({ ...base, CALDAV_ALL_DAY_BLOCKS: "FALSE" }).allDayBlocks).toBe(false);
    expect(resolveSyncConfig({ ...base, CALDAV_ALL_DAY_BLOCKS: "true" }).allDayBlocks).toBe(true);
    expect(resolveSyncConfig({ ...base, CALDAV_ALL_DAY_BLOCKS: "" }).allDayBlocks).toBe(true);
  });

  it("CALDAV_SYNC_EXPAND=false turns server-side expansion off", () => {
    expect(resolveSyncConfig({ ...base, CALDAV_SYNC_EXPAND: "false" }).expand).toBe(false);
  });

  it.each(["CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD", "MENTORING_TEACHER_ID"])("throws a clear error when %s is missing (without echoing secrets)", (name) => {
    const vars: Record<string, string | undefined> = { ...base, [name]: undefined };
    expect(() => resolveSyncConfig(vars)).toThrow(name);
    try {
      resolveSyncConfig(vars);
    } catch (e) {
      expect((e as Error).message).not.toContain("pw");
    }
  });
});
