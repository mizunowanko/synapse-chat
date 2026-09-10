import type {
  CLIAdapter,
  SessionOptions,
  StreamMessage,
  SystemMessage,
  TokenUsage,
  ToolResultMessage,
  ToolUseMessage,
  ResultMessage,
} from "@synapse-chat/core";
import { safeJsonParse } from "../util/json-safe.js";

/**
 * Adapter for the **Antigravity CLI** (`agy`).
 *
 * Not to be confused with {@link ../gemini.js | geminiAdapter}, which targets
 * Google's separate `gemini` CLI. Both speak to Gemini models, but they are
 * different binaries with incompatible flags and output formats.
 *
 * Surface measured against `agy` 1.2.0 (2026-09-10).
 *
 * ## Differences from Claude Code
 *
 * | Concern | Claude | `agy` |
 * | --- | --- | --- |
 * | Resume | `--resume <uuid>` | `--conversation <id>` |
 * | Workspace | implicit `cwd` | **`--add-dir <path>` (required)** |
 * | System prompt | `--append-system-prompt` | *no equivalent* — prepended to the prompt |
 * | Prompt + `--input-format` | allowed together | **rejected** (see below) |
 *
 * ## `--add-dir` is load-bearing
 *
 * Without it `agy` reports "no active workspace is currently set" and reads no
 * files at all. The failure is silent from the caller's perspective — the agent
 * simply answers without ever looking at the repo — so {@link SessionOptions.cwd}
 * is always forwarded when present.
 *
 * Note that `agy` discovers files by *scanning the workspace*, not by loading
 * well-known filenames. The file that is auto-loaded as standing instructions
 * is `AGENTS.md` (and `GEMINI.md`); `CLAUDE.md` is **not** picked up.
 *
 * ## Two mutually exclusive invocation modes
 *
 * `agy` refuses `-p <prompt>` together with `--input-format stream-json`:
 *
 * ```text
 * Error: --input-format stream-json reads prompts from stdin, so a prompt
 * given on the command line would be ignored
 * ```
 *
 * So the adapter picks one:
 *
 * - **prompt supplied** → `-p <prompt> --output-format stream-json` (one-shot)
 * - **no prompt** → `--print= --output-format stream-json --input-format stream-json`,
 *   taking turns from stdin as NDJSON via {@link formatAgyInput}
 */

const AGY_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /RESOURCE_EXHAUSTED/,
  /rate.?limit/i,
  /quota/i,
  /too many requests/i,
];

const AGY_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  ...AGY_RATE_LIMIT_PATTERNS,
  /UNAVAILABLE/,
  /DEADLINE_EXCEEDED/,
  /INTERNAL/,
  /\b5\d{2}\b/,
  /internal.?server.?error/i,
  /service.?unavailable/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
];

export function buildAgyArgs(options: SessionOptions): string[] {
  const args: string[] = [];

  // `agy` rejects a command-line prompt when reading stream-json from stdin,
  // so the two modes are exclusive.
  const prompt = composeAgyPrompt(options);
  if (prompt !== undefined) {
    args.push("-p", prompt);
    args.push("--output-format", "stream-json");
  } else {
    // `--print=` (attached empty value) rather than a bare `--print`: agy uses
    // Go's flag package, which would otherwise swallow the next token as the
    // prompt value.
    args.push("--print=");
    args.push("--output-format", "stream-json");
    args.push("--input-format", "stream-json");
  }

  if (options.model) {
    args.push("--model", options.model);
  }
  // Required — without a workspace agy cannot read any file. See class docs.
  if (options.cwd) {
    args.push("--add-dir", options.cwd);
  }
  if (options.resumeSessionId) {
    args.push("--conversation", options.resumeSessionId);
  }
  if (options.autoApprove) {
    args.push("--dangerously-skip-permissions");
  }

  return args;
}

/**
 * Fold `systemPrompt` into the prompt.
 *
 * `agy` has no `--append-system-prompt`, so the only in-band channel is the
 * prompt itself. Returns `undefined` when there is nothing to send on the
 * command line, which selects the stdin turn mode in {@link buildAgyArgs}.
 */
function composeAgyPrompt(options: SessionOptions): string | undefined {
  const { prompt, systemPrompt } = options;
  if (prompt === undefined) return undefined;
  if (!systemPrompt) return prompt;
  return `${systemPrompt}\n\n${prompt}`;
}

export function parseAgyOutput(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const raw = safeJsonParse<Record<string, unknown>>(trimmed, {
    source: "agyAdapter.parseOutput",
  });
  if (!raw) return null;

  switch (raw.event) {
    case "init":
      return parseAgyInit(raw);
    case "step_update":
      return parseAgyStepUpdate(raw);
    case "result":
      return parseAgyResult(raw);
    default:
      return null;
  }
}

/**
 * `{"event":"init","conversation_id":"…","init":{"model":…,"cwd":…,"tools":[…]}}`
 *
 * Surfaced as a `system` message so callers can capture `conversation_id` and
 * feed it back as {@link SessionOptions.resumeSessionId}.
 */
function parseAgyInit(raw: Record<string, unknown>): StreamMessage | null {
  const init = asRecord(raw.init) ?? {};
  const conversationId = pickString(raw, "conversation_id");
  const meta: Record<string, unknown> = {};
  if (conversationId) meta.conversationId = conversationId;
  const model = pickString(init, "model");
  if (model) meta.model = model;
  const cwd = pickString(init, "cwd");
  if (cwd) meta.cwd = cwd;
  const permissionMode = pickString(init, "permission_mode");
  if (permissionMode) meta.permissionMode = permissionMode;
  if (Array.isArray(init.tools)) meta.tools = init.tools;

  const message: SystemMessage = { type: "system", subtype: "init" };
  if (Object.keys(meta).length > 0) message.meta = meta;
  return message;
}

/**
 * `step_update` carries every mid-turn event, discriminated by `step_type`.
 *
 * - `agent_response` → assistant text, delivered incrementally as `text_delta`
 *   (agy *does* stream tokens; each fragment arrives with `state: "ACTIVE"`).
 * - `tool` → `tool_use` while `ACTIVE`, `tool_result` once `DONE` and
 *   `tool_info.output` is populated.
 * - `user_input` / `system_message` → no payload worth forwarding.
 */
function parseAgyStepUpdate(raw: Record<string, unknown>): StreamMessage | null {
  const step = asRecord(raw.step_update);
  if (!step) return null;

  const stepType = pickString(step, "step_type");
  const state = pickString(step, "state");

  if (stepType === "tool") {
    return parseAgyToolStep(step, state);
  }

  if (stepType === "agent_response") {
    const delta = pickString(step, "text_delta");
    if (!delta) return null;
    return { type: "assistant", content: delta };
  }

  return null;
}

function parseAgyToolStep(
  step: Record<string, unknown>,
  state: string | undefined,
): StreamMessage | null {
  const toolInfo = asRecord(step.tool_info) ?? {};
  const toolName =
    pickString(step, "tool_name") ?? pickString(toolInfo, "name") ?? "tool";
  // agy has no per-call id; step_index is unique within a conversation.
  const stepIndex = step.step_index;
  const toolUseId =
    typeof stepIndex === "number" ? `step-${stepIndex}` : undefined;

  const output = toolInfo.output;
  if (state === "DONE" && output !== undefined) {
    // ToolResultMessage has no `tool` field; the name rides along in `meta`
    // so consumers can still pair a result with its call.
    const message: ToolResultMessage = {
      type: "tool_result",
      content: typeof output === "string" ? output : JSON.stringify(output),
      meta: { tool: toolName },
    };
    if (toolUseId) message.toolUseId = toolUseId;
    return message;
  }

  const parameters = asRecord(toolInfo.parameters);
  const message: ToolUseMessage = {
    type: "tool_use",
    tool: toolName,
    content: parameters ? JSON.stringify(parameters, null, 2) : toolName,
  };
  if (parameters) message.toolInput = parameters;
  if (toolUseId) message.toolUseId = toolUseId;
  return message;
}

/**
 * `{"event":"result","result":{"status":"SUCCESS"|"ERROR","response":…,"usage":{…}}}`
 *
 * `status: "ERROR"` carries the message in `result.error` and leaves `response`
 * empty, so it maps to an `error` message rather than a `result`.
 */
function parseAgyResult(raw: Record<string, unknown>): StreamMessage | null {
  const result = asRecord(raw.result);
  if (!result) return null;

  const status = pickString(result, "status");
  const error = pickString(result, "error");
  if (status === "ERROR" || (error && error.length > 0)) {
    return { type: "error", content: error ?? "agy reported an error" };
  }

  const message: ResultMessage = {
    type: "result",
    content: pickString(result, "response") ?? "",
  };
  const conversationId = pickString(result, "conversation_id");
  if (conversationId) message.meta = { conversationId };
  const usage = extractAgyUsage(result);
  if (usage) message.usage = usage;
  return message;
}

/**
 * agy usage keys: `input_tokens` / `output_tokens` / `cache_read_tokens` /
 * `thinking_tokens` / `total_tokens`. There is no cache-*write* counter, so
 * {@link TokenUsage.cacheWrite} is left unset.
 */
function extractAgyUsage(source: Record<string, unknown>): TokenUsage | null {
  const usage = asRecord(source.usage);
  if (!usage) return null;

  const inputTokens = pickNumber(usage, "input_tokens") ?? 0;
  const outputTokens = pickNumber(usage, "output_tokens") ?? 0;
  const cacheRead = pickNumber(usage, "cache_read_tokens");

  if (inputTokens === 0 && outputTokens === 0 && !cacheRead) return null;

  const result: TokenUsage = { inputTokens, outputTokens };
  if (cacheRead !== undefined && cacheRead > 0) result.cacheRead = cacheRead;
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickNumber(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * NDJSON turn for `--input-format stream-json`.
 *
 * agy's envelope is *not* Claude's: it requires a top-level `event` field.
 * `{"type":"user",…}` is rejected with `stream input message is missing the
 * "event" field`, and unknown event names are dropped with a warning.
 */
export function formatAgyInput(message: string): string {
  return JSON.stringify({
    event: "user",
    message: { role: "user", content: message },
  });
}

export const agyAdapter: CLIAdapter = {
  command: process.env.AGY_CLI_PATH ?? "agy",
  buildArgs: buildAgyArgs,
  parseOutput: parseAgyOutput,
  formatInput: formatAgyInput,
  rateLimitPatterns: AGY_RATE_LIMIT_PATTERNS,
  retryableErrorPatterns: AGY_RETRYABLE_ERROR_PATTERNS,
};
