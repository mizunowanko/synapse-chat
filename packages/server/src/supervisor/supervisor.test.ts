import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  startSupervisor,
  type ChildLabel,
  type SupervisorHandle,
} from "./supervisor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "test-fixtures");
const ECHO = resolve(FIXTURES, "echo-worker.mjs");
const HANG = resolve(FIXTURES, "hang-worker.mjs");
const CRASH = resolve(FIXTURES, "crash-worker.mjs");

interface TestOpts {
  pm?: string;
  ws?: string;
  shutdownTimeout?: number;
  healthCheckInterval?: number;
  healthCheckTimeout?: number;
  maxRestarts?: number;
  onFatal?: (label: ChildLabel, count: number) => void;
}

const handles: SupervisorHandle[] = [];

function start(opts: TestOpts = {}): {
  handle: SupervisorHandle;
  terminated: ReturnType<typeof vi.fn>;
} {
  const terminated = vi.fn();
  const handle = startSupervisor({
    port: 0,
    pmWorkerScript: opts.pm ?? ECHO,
    wsServerChildScript: opts.ws ?? ECHO,
    shutdownTimeout: opts.shutdownTimeout ?? 300,
    ...(opts.healthCheckInterval !== undefined && {
      healthCheckInterval: opts.healthCheckInterval,
    }),
    ...(opts.healthCheckTimeout !== undefined && {
      healthCheckTimeout: opts.healthCheckTimeout,
    }),
    ...(opts.maxRestarts !== undefined && { maxRestarts: opts.maxRestarts }),
    ...(opts.onFatal && { onFatal: opts.onFatal }),
    onTerminate: terminated,
    installGlobalHandlers: false,
  });
  handles.push(handle);
  return { handle, terminated };
}

describe("startSupervisor", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Best-effort cleanup: stop any handles whose tests didn't already.
    for (const handle of handles) {
      try {
        handle.stop();
      } catch {
        // already stopped
      }
    }
    handles.length = 0;
    // Give SIGKILL escalation a moment to actually reap children.
    await sleep(500);
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("calls onTerminate after a graceful stop with responsive children", async () => {
    const { handle, terminated } = start({ shutdownTimeout: 400 });
    await sleep(200); // wait for child:ready
    handle.stop();
    await sleep(700); // > shutdownTimeout
    expect(terminated).toHaveBeenCalledTimes(1);
  });

  it("exposes stop() as an alias for shutdown()", async () => {
    const { handle, terminated } = start({ shutdownTimeout: 300 });
    await sleep(200);
    expect(handle.shutdown).toBe(handle.stop);
    handle.stop();
    await sleep(500);
    expect(terminated).toHaveBeenCalledTimes(1);
  });

  it("escalates to SIGKILL when children ignore the graceful shutdown signal", async () => {
    const { handle, terminated } = start({
      pm: HANG,
      ws: HANG,
      shutdownTimeout: 250,
    });
    await sleep(200);
    handle.stop();
    await sleep(600);
    expect(terminated).toHaveBeenCalledTimes(1);
    const sigkillLog = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("graceful shutdown timed out"),
    );
    expect(sigkillLog).toBe(true);
  });

  it("kills the PM worker when it stops responding to health checks", async () => {
    start({
      pm: HANG,
      ws: ECHO,
      healthCheckInterval: 80,
      healthCheckTimeout: 150,
      shutdownTimeout: 200,
    });
    // 80ms interval + 150ms pong timeout → SIGKILL ~230ms after first ping.
    await sleep(800);
    const healthKillLog = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("did not respond to health check"),
    );
    expect(healthKillLog).toBe(true);
  });

  it("invokes onFatal and shuts down once maxRestarts is exceeded", async () => {
    const onFatal = vi.fn();
    const { terminated } = start({
      pm: CRASH,
      ws: ECHO,
      maxRestarts: 1,
      onFatal,
      shutdownTimeout: 200,
    });
    // CRASH worker: ready → exit(1) ~20ms after spawn.
    // Cycle: spawn → exit → schedule restart (1s) → re-spawn → exit → fatal.
    await sleep(2_000);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toBe("pm-worker");
    await sleep(400);
    expect(terminated).toHaveBeenCalledTimes(1);
  }, 6_000);
});
