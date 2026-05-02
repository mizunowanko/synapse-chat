/**
 * Supervisor — lightweight parent process that manages child processes.
 *
 * Forks two children:
 *   1. WS/API Server (`wsServerChildScript`) — application WS server
 *   2. ProcessManager Worker (`pmWorkerScript`) — CLI spawn/kill/stdout
 *
 * Responsibilities:
 *   - Monitor child health and auto-restart on crash (exponential backoff)
 *   - Relay IPC messages between children (PM events → WS, WS commands → PM)
 *   - Graceful shutdown (IPC shutdown → SIGKILL after `shutdownTimeout`)
 *   - Optional health check ping → SIGKILL hung children
 *   - `maxRestarts` cap with `onFatal` escalation
 *
 * This implementation is generic: the concrete child scripts and the crash /
 * pre-restart hooks are supplied by the embedding application via
 * {@link SupervisorOptions}.
 */
import { fork, type ChildProcess, type Serializable } from "node:child_process";
import type {
  IpcEvent,
  IpcPingCommand,
  SupervisorToChild,
  ChildToSupervisor,
  IpcRequestStateDump,
} from "./ipc-types.js";

/** Max restart delay in ms (exponential backoff cap). */
const MAX_RESTART_DELAY_MS = 30_000;

/** Base restart delay in ms. */
const BASE_RESTART_DELAY_MS = 1_000;

/** Minimum uptime before resetting backoff counter (ms). */
const STABLE_UPTIME_MS = 60_000;

/** Default graceful-shutdown timeout (ms). */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Default health-check pong timeout (ms). */
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Delay between WS shutdown signal and PM shutdown signal (ms). */
const PM_SHUTDOWN_DELAY_MS = 2_000;

/** Brief settle time between SIGKILL and onTerminate so kill takes effect. */
const POST_KILL_SETTLE_MS = 100;

interface ChildState {
  process: ChildProcess | null;
  restartCount: number;
  lastStartTime: number;
  shuttingDown: boolean;
}

/** Identifier for a supervised child, used in fatal callback and logs. */
export type ChildLabel = "pm-worker" | "ws-server";

export interface SupervisorOptions {
  /** Port the WS/API server should listen on. Exposed to children via `ENGINE_PORT`. */
  port: number;
  /** Absolute path to the compiled ProcessManager worker script (must accept `fork()` IPC). */
  pmWorkerScript: string;
  /** Absolute path to the compiled WS/API server child script (must accept `fork()` IPC). */
  wsServerChildScript: string;
  /**
   * Invoked for supervisor-level crashes. The handler should be synchronous or
   * write to disk synchronously, because `process.exit` follows shortly after.
   */
  onCrash?: (error: unknown, context: string) => void;
  /**
   * Called before a graceful restart is actually performed (e.g. to `git pull`).
   * Any thrown error is caught and logged; the restart proceeds regardless.
   */
  onBeforeRestart?: () => Promise<void> | void;
  /** Extra env vars propagated to both children. Useful for app-specific config. */
  childEnv?: Record<string, string>;
  /**
   * Total time (ms) the graceful shutdown sequence is allowed to take before
   * SIGKILL is sent to any still-alive children. Defaults to 5_000.
   */
  shutdownTimeout?: number;
  /**
   * Interval (ms) at which the supervisor pings the PM worker over IPC.
   * If a `pong` is not received within `healthCheckTimeout`, the worker is
   * SIGKILLed and restarted via the normal exit/restart path.
   * Omit (or set to `undefined`) to disable health checks.
   */
  healthCheckInterval?: number;
  /** Pong response timeout (ms) for health checks. Defaults to 5_000. */
  healthCheckTimeout?: number;
  /**
   * Maximum number of restarts allowed per child before the supervisor gives
   * up. The counter is reset whenever a child stays alive for at least
   * {@link STABLE_UPTIME_MS}. Defaults to {@link Number.POSITIVE_INFINITY}
   * (unbounded — preserves the legacy behaviour).
   */
  maxRestarts?: number;
  /**
   * Invoked when a child exceeds {@link SupervisorOptions.maxRestarts}. After
   * the callback runs, the supervisor initiates its own shutdown sequence so
   * the embedding process can exit cleanly.
   */
  onFatal?: (label: ChildLabel, restartCount: number) => void;
  /**
   * Called once the graceful shutdown sequence finishes. Defaults to
   * `() => process.exit(0)`. Override (e.g. for tests) to keep the parent
   * process alive after shutdown.
   */
  onTerminate?: () => void;
  /**
   * Whether to install `uncaughtException` / `unhandledRejection` / `SIGINT` /
   * `SIGTERM` handlers on the supervisor process. Defaults to `true`. Set to
   * `false` if the embedding application installs its own handlers (or in
   * tests, to avoid contaminating the test runner process).
   */
  installGlobalHandlers?: boolean;
}

export interface SupervisorHandle {
  /** Trigger a graceful shutdown (IPC shutdown → SIGKILL fallback). */
  shutdown(signal?: string): void;
  /** Alias for {@link SupervisorHandle.shutdown}. */
  stop(signal?: string): void;
  /** Request a graceful restart of both children (re-fork after they exit). */
  restart(): void;
}

/**
 * Start the supervisor. Forks both children immediately and returns a handle
 * that can be used to drive graceful shutdown or a restart cycle.
 *
 * Installs `uncaughtException` / `unhandledRejection` / `SIGINT` / `SIGTERM`
 * handlers on `process` (unless `installGlobalHandlers: false`) — do not call
 * this more than once per process when global handlers are installed.
 */
export function startSupervisor(options: SupervisorOptions): SupervisorHandle {
  const {
    port,
    pmWorkerScript,
    wsServerChildScript,
    onCrash,
    onBeforeRestart,
    childEnv,
    shutdownTimeout = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    healthCheckInterval,
    healthCheckTimeout = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    maxRestarts = Number.POSITIVE_INFINITY,
    onFatal,
    onTerminate = () => process.exit(0),
    installGlobalHandlers = true,
  } = options;

  const pmState: ChildState = {
    process: null,
    restartCount: 0,
    lastStartTime: 0,
    shuttingDown: false,
  };

  const wsState: ChildState = {
    process: null,
    restartCount: 0,
    lastStartTime: 0,
    shuttingDown: false,
  };

  let isShuttingDown = false;
  let isRestarting = false;
  let terminated = false;

  let healthCheckTimer: NodeJS.Timeout | null = null;
  let pendingPingTimeout: NodeJS.Timeout | null = null;

  const baseEnv = {
    ...process.env,
    ENGINE_PORT: String(port),
    ...childEnv,
  };

  function safeTerminate(): void {
    if (terminated) return;
    terminated = true;
    try {
      onTerminate();
    } catch (err) {
      console.error("[supervisor] onTerminate threw:", err);
    }
  }

  function clearPendingPing(): void {
    if (pendingPingTimeout) {
      clearTimeout(pendingPingTimeout);
      pendingPingTimeout = null;
    }
  }

  function stopHealthCheck(): void {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }
    clearPendingPing();
  }

  function sendHealthPing(): void {
    const child = pmState.process;
    if (!child?.connected) return;
    if (pmState.shuttingDown || isShuttingDown) return;
    // Only one ping in flight at a time — if pong is overdue, the previous
    // pendingPingTimeout is already scheduled to kill the worker.
    if (pendingPingTimeout) return;

    const ping: IpcPingCommand = { type: "ping" };
    try {
      child.send(ping);
    } catch {
      // IPC closed — exit handler will fire and restart
      return;
    }

    pendingPingTimeout = setTimeout(() => {
      pendingPingTimeout = null;
      if (isShuttingDown || pmState.shuttingDown) return;
      if (child !== pmState.process) return; // worker already replaced
      console.warn(
        "[supervisor] PM worker did not respond to health check — SIGKILL",
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead — exit handler will run
      }
    }, healthCheckTimeout);
  }

  function startHealthCheck(): void {
    if (!healthCheckInterval || healthCheckInterval <= 0) return;
    if (healthCheckTimer) return;
    healthCheckTimer = setInterval(sendHealthPing, healthCheckInterval);
  }

  function forkPmWorker(): ChildProcess {
    const child = fork(pmWorkerScript, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: baseEnv,
    });
    pmState.process = child;
    pmState.lastStartTime = Date.now();

    child.on("message", (msg: Serializable) => {
      const typed = msg as IpcEvent | ChildToSupervisor;
      if (typed.type === "child:ready") {
        console.log("[supervisor] PM worker ready");
        startHealthCheck();
        return;
      }
      // Consume pong only if it answers our pending health-check ping.
      // Otherwise, fall through to the relay so a WS-initiated ping can pass.
      if (typed.type === "pong" && pendingPingTimeout) {
        clearPendingPing();
        return;
      }
      // Relay PM events to WS child
      if (wsState.process?.connected) {
        try {
          wsState.process.send(msg);
        } catch {
          // WS child may have died — events will be replayed via state-dump on restart
        }
      }
    });

    child.on("exit", (code, signal) => {
      console.warn(
        `[supervisor] PM worker exited (code=${code}, signal=${signal})`,
      );
      pmState.process = null;
      clearPendingPing();
      if (!isShuttingDown && !pmState.shuttingDown) {
        scheduleRestart(pmState, forkPmWorker, "pm-worker");
      }
    });

    child.on("error", (err) => {
      console.error("[supervisor] PM worker error:", err);
    });

    return child;
  }

  function forkWsChild(): ChildProcess {
    const child = fork(wsServerChildScript, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: baseEnv,
    });
    wsState.process = child;
    wsState.lastStartTime = Date.now();

    child.on("message", (msg: Serializable) => {
      const typed = msg as { type: string };
      if (typed.type === "child:ready") {
        console.log("[supervisor] WS server ready");
        // After WS restart, request state dump from PM so IpcProcessManager rebuilds mirror
        if (pmState.process?.connected) {
          try {
            pmState.process.send({
              type: "request-state-dump",
            } satisfies IpcRequestStateDump);
          } catch {
            // PM may not be ready yet
          }
        }
        return;
      }
      if (typed.type === "child:restart-request") {
        gracefulRestart();
        return;
      }
      // Relay WS commands to PM worker
      if (pmState.process?.connected) {
        try {
          pmState.process.send(msg);
        } catch {
          console.error("[supervisor] Failed to relay command to PM worker");
        }
      }
    });

    child.on("exit", (code, signal) => {
      console.warn(
        `[supervisor] WS server exited (code=${code}, signal=${signal})`,
      );
      wsState.process = null;
      if (!isShuttingDown && !wsState.shuttingDown) {
        scheduleRestart(wsState, forkWsChild, "ws-server");
      }
    });

    child.on("error", (err) => {
      console.error("[supervisor] WS server error:", err);
    });

    return child;
  }

  function scheduleRestart(
    state: ChildState,
    forkFn: () => ChildProcess,
    label: ChildLabel,
  ): void {
    const uptime = Date.now() - state.lastStartTime;

    if (uptime >= STABLE_UPTIME_MS) {
      state.restartCount = 0;
    }

    if (state.restartCount >= maxRestarts) {
      console.error(
        `[supervisor] ${label} exceeded maxRestarts (${maxRestarts}) — escalating to fatal`,
      );
      try {
        onFatal?.(label, state.restartCount);
      } catch (err) {
        console.error("[supervisor] onFatal threw:", err);
      }
      shutdown("fatal");
      return;
    }

    const delay = Math.min(
      BASE_RESTART_DELAY_MS * Math.pow(2, state.restartCount),
      MAX_RESTART_DELAY_MS,
    );
    state.restartCount++;

    console.log(
      `[supervisor] Restarting ${label} in ${delay}ms (attempt #${state.restartCount})`,
    );

    setTimeout(() => {
      if (isShuttingDown) return;
      console.log(`[supervisor] Forking ${label}...`);
      forkFn();
    }, delay);
  }

  /** Send IPC graceful-shutdown to a child; fall back to SIGTERM if IPC fails. */
  function sendShutdownOrSigterm(
    child: ChildProcess,
    msg: SupervisorToChild,
  ): void {
    if (child.connected) {
      try {
        child.send(msg);
        return;
      } catch {
        // fall through
      }
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
  }

  async function gracefulRestart(): Promise<void> {
    if (isRestarting || isShuttingDown) return;
    isRestarting = true;
    console.log(
      "[supervisor] Graceful restart requested — shutting down children for restart",
    );

    if (onBeforeRestart) {
      try {
        await onBeforeRestart();
      } catch (err) {
        console.error("[supervisor] onBeforeRestart hook failed:", err);
      }
    }

    // Pause health check during restart so we don't kill mid-restart.
    stopHealthCheck();

    const shutdownMsg: SupervisorToChild = { type: "supervisor:shutdown" };

    let wsExited = false;
    let pmExited = false;

    const tryRefork = () => {
      if (!wsExited || !pmExited) return;
      console.log(
        "[supervisor] All children exited — reforking with RESTARTED=1",
      );
      process.env.RESTARTED = "1";
      isRestarting = false;
      wsState.restartCount = 0;
      pmState.restartCount = 0;
      wsState.shuttingDown = false;
      pmState.shuttingDown = false;
      forkPmWorker();
      forkWsChild();
    };

    if (wsState.process) {
      wsState.shuttingDown = true;
      const wsChild = wsState.process;
      wsChild.once("exit", () => {
        wsExited = true;
        tryRefork();
      });
      sendShutdownOrSigterm(wsChild, shutdownMsg);
    } else {
      wsExited = true;
    }

    setTimeout(() => {
      if (pmState.process) {
        pmState.shuttingDown = true;
        const pmChild = pmState.process;
        pmChild.once("exit", () => {
          pmExited = true;
          tryRefork();
        });
        sendShutdownOrSigterm(pmChild, shutdownMsg);
      } else {
        pmExited = true;
        tryRefork();
      }

      // Force refork after timeout
      setTimeout(() => {
        if (!wsExited || !pmExited) {
          console.warn(
            "[supervisor] Force killing remaining children for restart",
          );
          if (!wsExited && wsState.process) wsState.process.kill("SIGKILL");
          if (!pmExited && pmState.process) pmState.process.kill("SIGKILL");
          wsExited = true;
          pmExited = true;
          tryRefork();
        }
      }, shutdownTimeout);
    }, Math.min(PM_SHUTDOWN_DELAY_MS, Math.max(0, shutdownTimeout - 100)));
  }

  function shutdown(signal = "shutdown"): void {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[supervisor] ${signal} received — shutting down children`);

    stopHealthCheck();

    const shutdownMsg: SupervisorToChild = { type: "supervisor:shutdown" };

    // 1. Tell WS to start cleanup. It can wind down independently.
    if (wsState.process) {
      wsState.shuttingDown = true;
      sendShutdownOrSigterm(wsState.process, shutdownMsg);
    }

    // 2. Tell PM to start cleanup after a short delay so WS gets a head start
    //    (PM may still be needed to kill in-flight CLIs while WS finishes).
    const pmDelay = Math.min(
      PM_SHUTDOWN_DELAY_MS,
      Math.max(0, shutdownTimeout - 100),
    );
    setTimeout(() => {
      if (pmState.process) {
        pmState.shuttingDown = true;
        sendShutdownOrSigterm(pmState.process, shutdownMsg);
      }
    }, pmDelay);

    // 3. After shutdownTimeout: SIGKILL anyone still alive, then terminate.
    setTimeout(() => {
      let killed = false;
      for (const state of [wsState, pmState]) {
        if (state.process) {
          console.warn(
            `[supervisor] SIGKILL child pid=${state.process.pid} (graceful shutdown timed out)`,
          );
          try {
            state.process.kill("SIGKILL");
            killed = true;
          } catch {
            // already dead
          }
        }
      }
      // Brief settle so the SIGKILL takes effect before we hand control back
      setTimeout(safeTerminate, killed ? POST_KILL_SETTLE_MS : 0);
    }, shutdownTimeout);
  }

  if (installGlobalHandlers) {
    process.on("uncaughtException", (err) => {
      console.error("[supervisor] Uncaught exception:", err);
      onCrash?.(err, "supervisor:uncaughtException");
      shutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason) => {
      console.error("[supervisor] Unhandled rejection:", reason);
      onCrash?.(reason, "supervisor:unhandledRejection");
      shutdown("unhandledRejection");
    });

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  console.log(`[supervisor] Starting synapse-chat server (port ${port})`);

  // Fork PM worker first (WS server needs it for IpcProcessManager)
  forkPmWorker();
  forkWsChild();

  console.log("[supervisor] Children forked");

  return {
    shutdown,
    stop: shutdown,
    restart: gracefulRestart,
  };
}
