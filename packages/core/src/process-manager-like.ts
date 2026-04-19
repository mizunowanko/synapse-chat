import type { ImageAttachment } from "./types.js";

/**
 * Result of sending a message or tool_result to a running CLI process.
 */
export type SendResult =
  | { ok: true }
  | { ok: false; reason: "not-writable" | "process-not-found" };

/**
 * Events emitted by a {@link ProcessManagerLike} implementation.
 *
 * Implementations extend Node.js's `EventEmitter`, so consumers can subscribe
 * via `.on("data", ...)` etc. The typed interface below exists so that both
 * the real in-process manager and IPC proxies agree on the payload shapes.
 */
export interface ProcessEvents {
  data: (id: string, message: Record<string, unknown>) => void;
  exit: (id: string, code: number | null) => void;
  error: (id: string, error: Error) => void;
  "rate-limit": (id: string) => void;
  spawn: (id: string) => void;
}

/**
 * Contract for a CLI process manager.
 *
 * Two implementations exist:
 *   - In-process `ProcessManager` that spawns Claude CLI subprocesses directly.
 *   - `IpcProcessManager` that forwards calls across a Node.js `fork()` IPC
 *     channel to a worker process running `ProcessManager`.
 *
 * Both expose the same surface so consumers can swap implementations without
 * caring about the transport.
 */
export interface ProcessManagerLike {
  /**
   * Start a new "sortie" session — a non-interactive CLI run (`-p <prompt>`)
   * scoped to a worktree with a skill invocation.
   */
  sortie(
    id: string,
    worktreePath: string,
    issueNumber: number,
    extraPrompt?: string,
    skill?: string,
    extraEnv?: Record<string, string>,
  ): void;

  /**
   * Start a "dispatch" CLI run — a one-shot investigation or modification task
   * in a given cwd.
   */
  dispatchSortie(
    id: string,
    cwd: string,
    prompt: string,
    type: "investigate" | "modify",
    extraEnv?: Record<string, string>,
  ): void;

  /**
   * Launch an interactive commander CLI (stdin pipe open for streamed input).
   */
  launchCommander(
    id: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): void;

  /**
   * Resume an interactive commander CLI via `--resume <sessionId>`.
   */
  resumeCommander(
    id: string,
    sessionId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): void;

  /**
   * Resume a non-interactive sortie session with a follow-up prompt.
   */
  resumeSession(
    id: string,
    sessionId: string,
    message: string,
    cwd: string,
    extraEnv?: Record<string, string>,
    appendSystemPrompt?: string,
    logFileName?: string,
  ): void;

  /** Send a text message (optionally with images) to a running commander's stdin. */
  sendMessage(
    id: string,
    message: string,
    images?: ImageAttachment[],
  ): SendResult;

  /** Send a `tool_result` reply to a running commander's stdin. */
  sendToolResult(id: string, toolUseId: string, result: string): SendResult;

  /** Terminate a single process; returns `true` if the process was running. */
  kill(id: string): boolean;
  /** Terminate every known process. */
  killAll(): void;

  isRunning(id: string): boolean;
  getActiveCount(): number;
  getPid(id: string): number | undefined;

  on<K extends keyof ProcessEvents>(event: K, listener: ProcessEvents[K]): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  emit<K extends keyof ProcessEvents>(
    event: K,
    ...args: Parameters<ProcessEvents[K]>
  ): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, ...args: any[]): boolean;
  removeAllListeners(event?: string): this;
}
