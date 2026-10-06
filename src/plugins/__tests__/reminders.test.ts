import { describe, it, expect, vi } from "vitest";
import { remindersEnabled, createGuardedTick } from "../reminders";

describe("remindersEnabled", () => {
  it("is on by default (production images do not set NODE_ENV)", () => {
    expect(remindersEnabled({})).toBe(true);
    expect(remindersEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(remindersEnabled({ NODE_ENV: "development" })).toBe(true);
  });
  it("is off when REMINDERS_ENABLED is the string 'false' (case-insensitive)", () => {
    expect(remindersEnabled({ REMINDERS_ENABLED: "false" })).toBe(false);
    expect(remindersEnabled({ REMINDERS_ENABLED: "FALSE" })).toBe(false);
    expect(remindersEnabled({ REMINDERS_ENABLED: "true" })).toBe(true);
  });
  it("is always off under NODE_ENV=test, even if explicitly enabled", () => {
    expect(remindersEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(remindersEnabled({ NODE_ENV: "test", REMINDERS_ENABLED: "true" })).toBe(false);
  });
});

describe("createGuardedTick", () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("skips a tick while the previous run is still in flight", async () => {
    let release!: () => void;
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const l = log();
    const tick = createGuardedTick(run, l);

    const first = tick();
    await tick(); // overlapping: must be skipped
    expect(run).toHaveBeenCalledTimes(1);
    expect(l.warn).toHaveBeenCalled();

    release();
    await first;
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the guard and logs when a run throws", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const l = log();
    const tick = createGuardedTick(run, l);

    await tick();
    expect(l.error).toHaveBeenCalledTimes(1);
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
