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
 *   - Graceful shutdown ordering (WS first, then PM)
 *
 * This implementation is generic: the concrete child scripts and the crash /
 * pre-restart hooks are supplied by the embedding application via
 * {@link SupervisorOptions}.
 */
import { fork, type ChildProcess, type Serializable } from "node:child_process";
import type {
  IpcEvent,
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

interface ChildState {
  process: ChildProcess | null;
  restartCount: number;
  lastStartTime: number;
  shuttingDown: boolean;
}

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
}

export interface SupervisorHandle {
  /** Trigger a graceful shutdown (SIGTERM-equivalent). */
  shutdown(signal?: string): void;
  /** Request a graceful restart of both children (re-fork after they exit). */
  restart(): void;
}

/**
 * Start the supervisor. Forks both children immediately and returns a handle
 * that can be used to drive graceful shutdown or a restart cycle.
 *
 * Installs `uncaughtException` / `unhandledRejection` / `SIGINT` / `SIGTERM`
 * handlers on `process` — do not call this more than once per process.
 */
export function startSupervisor(options: SupervisorOptions): SupervisorHandle {
  const {
    port,
    pmWorkerScript,
    wsServerChildScript,
    onCrash,
    onBeforeRestart,
    childEnv,
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

  const baseEnv = {
    ...process.env,
    ENGINE_PORT: String(port),
    ...childEnv,
  };

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
      if (!isShuttingDown && !pmState.shuttingDown) {
        scheduleRestart(pmState, forkPmWorker, "PM worker");
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
        scheduleRestart(wsState, forkWsChild, "WS server");
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
    label: string,
  ): void {
    const uptime = Date.now() - state.lastStartTime;

    if (uptime >= STABLE_UPTIME_MS) {
      state.restartCount = 0;
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
      try {
        wsChild.send(shutdownMsg);
      } catch {
        wsChild.kill("SIGTERM");
      }
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
        try {
          pmChild.send(shutdownMsg);
        } catch {
          pmChild.kill("SIGTERM");
        }
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
      }, 5_000);
    }, 2_000);
  }

  function shutdown(signal = "shutdown"): void {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[supervisor] ${signal} received — shutting down children`);

    const shutdownMsg: SupervisorToChild = { type: "supervisor:shutdown" };

    if (wsState.process?.connected) {
      wsState.shuttingDown = true;
      try {
        wsState.process.send(shutdownMsg);
      } catch {
        wsState.process.kill("SIGTERM");
      }
    }

    setTimeout(() => {
      if (pmState.process?.connected) {
        pmState.shuttingDown = true;
        try {
          pmState.process.send(shutdownMsg);
        } catch {
          pmState.process.kill("SIGTERM");
        }
      }

      setTimeout(() => {
        console.log("[supervisor] Force exit");
        process.exit(0);
      }, 5_000);
    }, 2_000);
  }

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

  console.log(`[supervisor] Starting synapse-chat server (port ${port})`);

  // Fork PM worker first (WS server needs it for IpcProcessManager)
  forkPmWorker();
  forkWsChild();

  console.log("[supervisor] Children forked");

  return {
    shutdown,
    restart: gracefulRestart,
  };
}
