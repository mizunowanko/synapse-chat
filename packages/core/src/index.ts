export type {
  Attachment,
  AttachmentImageMediaType,
  ImageAttachment,
  StreamMessage,
  StreamMessageBase,
  StreamMessageType,
  AssistantMessage,
  ThinkingMessage,
  ToolUseMessage,
  ToolResultMessage,
  ResultMessage,
  UserMessage,
  SystemMessage,
  ErrorMessage,
  HistoryMessage,
  QuestionMessage,
  TokenUsage,
} from "./types.js";
export { isAssistantBody, isThinkingMessage, assertNever } from "./types.js";
export type { CLIAdapter, SessionOptions } from "./cli-adapter.js";
export type {
  ProcessManagerLike,
  ProcessEvents,
  SendResult,
} from "./process-manager-like.js";
export type { ChatStorage } from "./storage.js";

/**
 * Briefing — the provider-neutral statement of an agent's instructions.
 *
 * **Types only here; the implementation is `@synapse-chat/core/briefing`.**
 * This entry point is bundled for the browser (`@synapse-chat/react` imports it
 * from a Vite build), while `collect()` reads the filesystem and the
 * fingerprint hashes with `node:crypto`. Re-exporting the values would drag
 * `node:fs` into that bundle and fail the build with "createHash is not
 * exported by __vite-browser-external" — which is what happened when they were.
 *
 * Types are erased at compile time, so naming the vocabulary here costs the
 * browser nothing and keeps `Briefing` reachable from the package root for
 * anything that only needs to describe a briefing rather than hand one out.
 */
export type {
  Briefing,
  BriefingRule,
  BriefingSection,
  BriefingSkill,
  BriefingSubagent,
  CollectResult,
  HandoutFiles,
  Layout,
  LayoutName,
  MarkedUpFile,
  ProviderFrontmatter,
} from "./briefing/index.js";
