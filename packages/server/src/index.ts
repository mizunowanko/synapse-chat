export {
  ProcessManager,
  COMMANDER_ALLOWED_TOOLS,
  isRetryableError,
  isRateLimitError,
  type DispatchOptions,
} from "./process-manager.js";
export {
  attachStdoutProcessor,
  attachStderrProcessor,
  type StreamCallbacks,
  type StreamLineParser,
} from "./stream-processor.js";
export {
  parseStreamMessage,
  extractSessionId,
  extractResultUsage,
  type ResultUsage,
} from "./stream-parser.js";
export { safeJsonParse, type ParseJsonSafeOptions } from "./util/json-safe.js";

// Supervisor + IPC are also exposed via the "./supervisor" subpath export.
export {
  startSupervisor,
  type SupervisorOptions,
  type SupervisorHandle,
} from "./supervisor/supervisor.js";
export {
  IpcProcessManager,
  type IpcChannel,
} from "./supervisor/ipc-process-manager.js";

// Re-export core types that server consumers will want alongside the runtime.
export type {
  CLIAdapter,
  SessionOptions,
  ProcessManagerLike,
  ProcessEvents,
  SendResult,
  StreamMessage,
  StreamMessageType,
  ImageAttachment,
} from "@synapse-chat/core";

// CLI adapters (Claude, Gemini). Re-exported via the "./adapters" subpath too.
export {
  claudeAdapter,
  buildClaudeArgs,
  parseClaudeOutput,
  formatClaudeInput,
  geminiAdapter,
  buildGeminiArgs,
  parseGeminiOutput,
  formatGeminiInput,
} from "./adapters/index.js";
