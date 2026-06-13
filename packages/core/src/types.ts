/**
 * Stream message types emitted by a CLI adapter, modeled as a typed
 * discriminated union (ADR-0018 §3).
 *
 * Derived from Claude Code's stream-json output and generalized so that other
 * CLIs (e.g. Gemini, Ollama) can emit the same shape. Framework-level
 * streaming semantics — a plain assistant body delta, a `thinking` chunk,
 * `tool_use` / `tool_result`, and a terminal `result` carrying token usage —
 * are distinct variants so that an emit/consume convention drift surfaces as a
 * compile error rather than a silent runtime bug.
 *
 * App-specific semantics layer onto the open {@link SystemMessage} variant via
 * a free-form `subtype` plus a typed `meta` record; the framework does not
 * interpret either. This keeps the extension surface type-safe without forcing
 * generic synapse-chat to enumerate app concepts.
 */

export type StreamMessageType =
  | "assistant"
  | "user"
  | "system"
  | "result"
  | "error"
  | "tool_use"
  | "tool_result"
  | "history"
  | "question";

/** Base64-encoded image attached to a user message. */
export interface ImageAttachment {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/**
 * Normalized token usage attached to a `result` {@link StreamMessage}.
 *
 * Adapters populate this from the underlying CLI's session-end metadata.
 * `cacheRead` and `cacheWrite` map to prompt-cache hit / write counts when
 * the CLI exposes them.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Fields shared by every {@link StreamMessage} variant. */
export interface StreamMessageBase {
  timestamp?: number;
  /** App-specific metadata. The framework does not interpret this. */
  meta?: Record<string, unknown>;
}

/**
 * A plain assistant body delta. Per-token streaming (e.g. Ollama) emits one of
 * these per chunk; consumers concatenate consecutive deltas into one bubble.
 * The absent `subtype` is what distinguishes it from {@link ThinkingMessage}.
 */
export interface AssistantMessage extends StreamMessageBase {
  type: "assistant";
  subtype?: undefined;
  content: string;
  images?: ImageAttachment[];
  imageCount?: number;
}

/** An assistant reasoning ("thinking") chunk, grouped separately from body. */
export interface ThinkingMessage extends StreamMessageBase {
  type: "assistant";
  subtype: "thinking";
  content: string;
}

/** A tool invocation. */
export interface ToolUseMessage extends StreamMessageBase {
  type: "tool_use";
  tool?: string;
  content?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
}

/** The result of a tool invocation. */
export interface ToolResultMessage extends StreamMessageBase {
  type: "tool_result";
  content?: string;
  toolUseId?: string;
}

/** Terminal message for a generation; carries token usage when available. */
export interface ResultMessage extends StreamMessageBase {
  type: "result";
  content?: string;
  /** Populated by adapters when the CLI reports session-end token counts. */
  usage?: TokenUsage;
}

/** An echoed user message. */
export interface UserMessage extends StreamMessageBase {
  type: "user";
  content?: string;
  images?: ImageAttachment[];
  imageCount?: number;
}

/**
 * App-extensible control / system message. The framework does not interpret
 * `subtype`; apps layer their own semantics (e.g. `compact-status`,
 * `dispatch-log`, `task-notification`) on top. This single open variant is the
 * type-safe extension point that replaces the former index signature.
 */
export interface SystemMessage extends StreamMessageBase {
  type: "system";
  /** App-specific subcategory. The framework does not interpret this. */
  subtype?: string;
  content?: string;
}

/** A transport- or CLI-level error surfaced into the stream. */
export interface ErrorMessage extends StreamMessageBase {
  type: "error";
  content?: string;
}

/** A replayed history entry. */
export interface HistoryMessage extends StreamMessageBase {
  type: "history";
  content?: string;
}

/** A question awaiting user input. */
export interface QuestionMessage extends StreamMessageBase {
  type: "question";
  content?: string;
}

/**
 * A single normalized event from a CLI stream, as a discriminated union over
 * {@link StreamMessageType}. Adapters map CLI-specific stdout lines to one of
 * these variants via {@link CLIAdapter.parseOutput}.
 */
export type StreamMessage =
  | AssistantMessage
  | ThinkingMessage
  | ToolUseMessage
  | ToolResultMessage
  | ResultMessage
  | UserMessage
  | SystemMessage
  | ErrorMessage
  | HistoryMessage
  | QuestionMessage;

/** True for a plain assistant body delta (mergeable per-token chunk). */
export function isAssistantBody(
  message: StreamMessage,
): message is AssistantMessage {
  return message.type === "assistant" && message.subtype === undefined;
}

/** True for an assistant `thinking` chunk. */
export function isThinkingMessage(
  message: StreamMessage,
): message is ThinkingMessage {
  return message.type === "assistant" && message.subtype === "thinking";
}

/**
 * Exhaustiveness guard. Reaching this in a `switch`/`if` chain at compile time
 * means a {@link StreamMessage} variant is unhandled; at runtime it throws so
 * the convention drift is loud rather than silent.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled StreamMessage variant: ${JSON.stringify(value)}`);
}
