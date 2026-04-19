/**
 * IPC message types for inter-process communication between Supervisor children.
 *
 * WS/API Server ←→ ProcessManager Worker communicate via Node.js fork() IPC.
 * Messages are serialized as JSON by Node.js automatically.
 */
import type { ImageAttachment } from "@synapse-chat/core";

// ── Commands: WS/API Server → ProcessManager Worker ──

export type IpcSortieCommand = {
  type: "sortie";
  id: string;
  worktreePath: string;
  issueNumber: number;
  extraPrompt?: string | undefined;
  skill?: string | undefined;
  extraEnv?: Record<string, string> | undefined;
};

export type IpcDispatchSortieCommand = {
  type: "dispatch-sortie";
  id: string;
  cwd: string;
  prompt: string;
  dispatchType: "investigate" | "modify";
  extraEnv?: Record<string, string> | undefined;
};

export type IpcLaunchCommanderCommand = {
  type: "launch-commander";
  id: string;
  fleetPath: string;
  additionalDirs: string[];
  systemPrompt?: string | undefined;
  extraEnv?: Record<string, string> | undefined;
};

export type IpcResumeCommanderCommand = {
  type: "resume-commander";
  id: string;
  sessionId: string;
  fleetPath: string;
  additionalDirs: string[];
  systemPrompt?: string | undefined;
  extraEnv?: Record<string, string> | undefined;
};

export type IpcResumeSessionCommand = {
  type: "resume-session";
  id: string;
  sessionId: string;
  message: string;
  cwd: string;
  extraEnv?: Record<string, string> | undefined;
  appendSystemPrompt?: string | undefined;
  logFileName?: string | undefined;
};

export type IpcSendMessageCommand = {
  type: "send-message";
  id: string;
  message: string;
  images?: ImageAttachment[] | undefined;
};

export type IpcSendToolResultCommand = {
  type: "send-tool-result";
  id: string;
  toolUseId: string;
  result: string;
};

export type IpcKillCommand = {
  type: "kill";
  id: string;
};

export type IpcKillAllCommand = {
  type: "kill-all";
};

export type IpcPingCommand = {
  type: "ping";
};

/** All commands from WS/API Server → ProcessManager Worker */
export type IpcCommand =
  | IpcSortieCommand
  | IpcDispatchSortieCommand
  | IpcLaunchCommanderCommand
  | IpcResumeCommanderCommand
  | IpcResumeSessionCommand
  | IpcSendMessageCommand
  | IpcSendToolResultCommand
  | IpcKillCommand
  | IpcKillAllCommand
  | IpcPingCommand;

// ── Events: ProcessManager Worker → WS/API Server ──

export type IpcSpawnEvent = {
  type: "spawn";
  id: string;
  pid: number | undefined;
};

export type IpcDataEvent = {
  type: "data";
  id: string;
  message: Record<string, unknown>;
};

export type IpcExitEvent = {
  type: "exit";
  id: string;
  code: number | null;
};

export type IpcErrorEvent = {
  type: "error";
  id: string;
  errorMessage: string;
};

export type IpcRateLimitEvent = {
  type: "rate-limit";
  id: string;
};

export type IpcKillResultEvent = {
  type: "kill-result";
  id: string;
  success: boolean;
};

export type IpcSendResultEvent = {
  type: "send-result";
  id: string;
  success: boolean;
};

export type IpcPongEvent = {
  type: "pong";
};

/** State dump sent when a new WS/API child connects (restart recovery). */
export type IpcStateDumpEvent = {
  type: "state-dump";
  /** Currently running process IDs with their PIDs. */
  processes: Array<{ id: string; pid: number | undefined }>;
};

/** All events from ProcessManager Worker → WS/API Server */
export type IpcEvent =
  | IpcSpawnEvent
  | IpcDataEvent
  | IpcExitEvent
  | IpcErrorEvent
  | IpcRateLimitEvent
  | IpcKillResultEvent
  | IpcSendResultEvent
  | IpcPongEvent
  | IpcStateDumpEvent;

// ── Supervisor ↔ Child communication ──

export type SupervisorToChild = {
  type: "supervisor:shutdown";
};

/** Sent by a child to request a graceful restart of all children. */
export type ChildRestartRequest = {
  type: "child:restart-request";
};

export type ChildToSupervisor =
  | { type: "child:ready" }
  | ChildRestartRequest;

/** Request state dump from ProcessManager Worker (sent by Supervisor after WS child restart). */
export type IpcRequestStateDump = {
  type: "request-state-dump";
};

/** IPC messages that ProcessManager Worker accepts */
export type ProcessManagerWorkerMessage =
  | IpcCommand
  | IpcRequestStateDump
  | SupervisorToChild;

/** IPC messages that WS/API Server child accepts */
export type WsServerChildMessage = IpcEvent | SupervisorToChild;
