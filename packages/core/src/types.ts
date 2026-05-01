/**
 * Stream message types emitted by a CLI adapter.
 *
 * Derived from Claude Code's stream-json output and generalized so that other
 * CLIs (e.g. Gemini) can emit the same shape. Apps layer their own semantics
 * on top via `subtype` (free-form string) and `meta` (free-form record).
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

/**
 * A single normalized event from a CLI stream.
 *
 * Adapters are responsible for mapping CLI-specific stdout lines to this shape
 * via {@link CLIAdapter.parseOutput}. Additional fields are allowed (index
 * signature) so apps can smuggle adapter-specific payloads without widening
 * the core type.
 */
export interface StreamMessage {
  type: StreamMessageType;
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  /** App-specific subcategory. Framework does not interpret this. */
  subtype?: string;
  /** App-specific metadata. Framework does not interpret this. */
  meta?: Record<string, unknown>;
  timestamp?: number;
  images?: ImageAttachment[];
  imageCount?: number;
  /** Token usage; populated by adapters on `type: "result"` messages when available. */
  usage?: TokenUsage;
  [key: string]: unknown;
}
