import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RedisGuard, RedisUnavailableError } from "../guard";

let t = 1_000_000;
const now = () => t;
const advance = (ms: number) => (t += ms);

function make(opts: { timeoutMs?: number; cooldownMs?: number } = {}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  return { guard: new RedisGuard({ timeoutMs: 100, cooldownMs: 1000, now, log, ...opts }), log };
}

const ok = () => vi.fn(async () => "pong");
const boom = () =>
  vi.fn(async () => {
    throw new Error("ECONNREFUSED");
  });

beforeEach(() => {
  t = 1_000_000;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("RedisGuard", () => {
  it("closed: runs the operation and returns its result", async () => {
    const { guard } = make();
    expect(await guard.run(ok())).toBe("pong");
    expect(guard.isDegraded).toBe(false);
    expect(guard.isOpen).toBe(false);
  });

  it("a failure opens the breaker: later calls are rejected without running the operation", async () => {
    const { guard, log } = make();
    await expect(guard.run(boom())).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(guard.isOpen).toBe(true);
    expect(guard.isDegraded).toBe(true);
    const op = ok();
    await expect(guard.run(op)).rejects.toThrow(/circuit open/);
    expect(op).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("a hanging operation is cut off by the timeout (fake timers, no wall clock)", async () => {
    const { guard } = make({ timeoutMs: 100 });
    const p = guard.run(() => new Promise(() => {}));
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(guard.isOpen).toBe(true);
  });

  it("honors a per-call timeout override", async () => {
    const { guard } = make({ timeoutMs: 100 });
    let resolve!: (v: string) => void;
    const slow = () => new Promise<string>((r) => (resolve = r));
    const p = guard.run(slow, 5000);
    await vi.advanceTimersByTimeAsync(1000); // past the default budget, inside the override
    resolve("late but fine");
    expect(await p).toBe("late but fine");
  });

  it("half-open: after the cooldown exactly ONE caller probes, concurrent callers go to their fallback", async () => {
    const { guard } = make();
    await guard.run(boom()).catch(() => {});
    advance(1001); // cooldown elapsed

    let finishProbe!: (v: string) => void;
    const probeOp = vi.fn(() => new Promise<string>((r) => (finishProbe = r)));
    const probe = guard.run(probeOp);

    const other = ok();
    await expect(guard.run(other)).rejects.toThrow(/probe in flight/);
    await expect(guard.run(other)).rejects.toThrow(/probe in flight/);
    expect(other).not.toHaveBeenCalled();
    expect(probeOp).toHaveBeenCalledTimes(1);

    finishProbe("pong");
    expect(await probe).toBe("pong");
    // probe succeeded: closed again, everyone runs
    expect(guard.isDegraded).toBe(false);
    await expect(guard.run(other)).resolves.toBe("pong");
  });

  it("half-open failure re-opens the breaker with a fresh cooldown", async () => {
    const { guard, log } = make({ cooldownMs: 1000 });
    await guard.run(boom()).catch(() => {});
    advance(1001);
    await expect(guard.run(boom())).rejects.toBeInstanceOf(RedisUnavailableError); // failed probe
    expect(guard.isOpen).toBe(true);

    advance(999); // less than a full NEW cooldown since the failed probe
    const op = ok();
    await expect(guard.run(op)).rejects.toThrow(/circuit open/);
    expect(op).not.toHaveBeenCalled();

    advance(2); // fresh cooldown elapsed: next call is the new probe
    await expect(guard.run(op)).resolves.toBe("pong");
    expect(log.warn).toHaveBeenCalledTimes(1); // still one outage, one warning
    expect(log.info).toHaveBeenCalledTimes(1); // and one recovery line
  });

  it("markHealthy (socket 'ready') closes the breaker immediately, without waiting for the cooldown", async () => {
    const { guard, log } = make();
    await guard.run(boom()).catch(() => {});
    expect(guard.isOpen).toBe(true);
    guard.markHealthy();
    expect(guard.isOpen).toBe(false);
    expect(guard.isDegraded).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("recovered"));
    await expect(guard.run(ok())).resolves.toBe("pong");
  });

  it("releases the probe slot even when the probe throws synchronously", async () => {
    const { guard } = make();
    await guard.run(boom()).catch(() => {});
    advance(1001);
    await guard.run(() => {
      throw new Error("sync");
    }).catch(() => {});
    advance(1001);
    await expect(guard.run(ok())).resolves.toBe("pong"); // not stuck in "probe in flight"
  });
});
