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
 * Adapter for the **Codex CLI** (`codex`).
 *
 * Surface measured against `codex-cli` 0.153.4 (2026-09-10).
 *
 * ## Differences from Claude Code
 *
 * | Concern | Claude | `codex` |
 * | --- | --- | --- |
 * | Non-interactive | `-p <prompt>` | `exec [OPTIONS] <PROMPT>` (positional) |
 * | Structured output | `--output-format stream-json` | `--json` (JSONL) |
 * | Working directory | implicit `cwd` | `-C <dir>` |
 * | Resume | `--resume <uuid>` | `exec [OPTIONS] resume <id> <prompt>` |
 * | System prompt | `--append-system-prompt` | *no equivalent* — prepended to the prompt |
 * | Auto-approve | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
 *
 * ## Option order matters
 *
 * `resume` is a subcommand of `exec`, and clap only accepts `exec`'s options
 * *before* it. `codex exec resume <id> -C /tmp` fails with
 * `error: unexpected argument '-C' found`, so every flag is emitted ahead of
 * the `resume` token.
 *
 * ## `--skip-git-repo-check` is always passed
 *
 * Outside a git repository `codex` refuses to start:
 * `Not inside a trusted directory and --skip-git-repo-check was not specified.`
 * Callers dispatch against scratch directories and worktrees that may not be
 * repos, so the check is disabled unconditionally rather than guessed at.
 *
 * ## stdin
 *
 * `codex exec` reads stdin even when the prompt is a positional argument
 * (`Reading additional input from stdin...` on stderr) and appends it as a
 * `<stdin>` block. `ProcessManager.dispatch` spawns with `stdio[0] = "ignore"`,
 * so the read hits EOF immediately. There is no interactive turn protocol, so
 * this adapter deliberately omits `formatInput`.
 *
 * ## No token streaming
 *
 * `--json` has no counterpart to Claude's `--include-partial-messages`.
 * Measured across several runs (including a 334-output-token response), the
 * smallest text unit emitted is a completed `item.completed` /
 * `type: "agent_message"`. {@link SessionOptions.stream} is therefore ignored,
 * which {@link CLIAdapter} explicitly permits.
 */

const CODEX_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /quota/i,
  /usage limit/i,
];

const CODEX_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  ...CODEX_RATE_LIMIT_PATTERNS,
  /\b5\d{2}\b/,
  /internal.?server.?error/i,
  /service.?unavailable/i,
  /stream disconnected/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
];

export function buildCodexArgs(options: SessionOptions): string[] {
  const args: string[] = ["exec", "--json", "--skip-git-repo-check"];

  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.cwd) {
    args.push("-C", options.cwd);
  }
  if (options.autoApprove) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  // `resume` is a subcommand: all `exec` options must already be on the line.
  if (options.resumeSessionId) {
    args.push("resume", options.resumeSessionId);
  }

  const prompt = composeCodexPrompt(options);
  if (prompt !== undefined) {
    args.push(prompt);
  }

  return args;
}

/**
 * Fold `systemPrompt` into the prompt.
 *
 * `codex` has no `--append-system-prompt`; the supported channels are the
 * prompt itself and an `AGENTS.md` in the workspace. Only the former is under
 * the adapter's control.
 */
function composeCodexPrompt(options: SessionOptions): string | undefined {
  const { prompt, systemPrompt } = options;
  if (prompt === undefined || prompt === "") return undefined;
  if (!systemPrompt) return prompt;
  return `${systemPrompt}\n\n${prompt}`;
}

export function parseCodexOutput(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const raw = safeJsonParse<Record<string, unknown>>(trimmed, {
    source: "codexAdapter.parseOutput",
  });
  if (!raw) return null;

  switch (raw.type) {
    case "thread.started":
      return parseCodexThreadStarted(raw);
    case "item.started":
    case "item.updated":
    case "item.completed":
      return parseCodexItem(raw);
    case "turn.completed":
      return parseCodexTurnCompleted(raw);
    case "turn.failed":
    case "error":
      return parseCodexFailure(raw);
    // `turn.started` carries no payload.
    default:
      return null;
  }
}

/**
 * `{"type":"thread.started","thread_id":"01a0…"}`
 *
 * The `thread_id` is what `codex exec resume <id>` takes, so it is surfaced as
 * a `system` init message for the caller to persist as
 * {@link SessionOptions.resumeSessionId}.
 */
function parseCodexThreadStarted(
  raw: Record<string, unknown>,
): StreamMessage | null {
  const threadId = pickString(raw, "thread_id");
  const message: SystemMessage = { type: "system", subtype: "init" };
  if (threadId) message.meta = { threadId };
  return message;
}

/**
 * `item.*` events wrap a discriminated `item` payload.
 *
 * `item.type` values handled here: `agent_message` (final assistant text),
 * `command_execution` (shell tool call), `reasoning`, `mcp_tool_call` and
 * `error`. Unrecognized item types are skipped rather than guessed at, so a
 * newer codex can add events without this adapter emitting garbage.
 *
 * Only `item.completed` is forwarded for text-bearing items — `item.started`
 * for an `agent_message` would carry no text, and forwarding both would double
 * up the transcript.
 */
function parseCodexItem(raw: Record<string, unknown>): StreamMessage | null {
  const item = asRecord(raw.item);
  if (!item) return null;
  const completed = raw.type === "item.completed";

  switch (item.type) {
    case "agent_message": {
      if (!completed) return null;
      const text = pickString(item, "text");
      if (!text) return null;
      return { type: "assistant", content: text };
    }

    case "error": {
      const text = pickString(item, "message") ?? pickString(item, "text");
      return { type: "error", content: text ?? "codex reported an error" };
    }

    case "command_execution":
      return parseCodexCommand(item, completed);

    case "mcp_tool_call":
      return parseCodexMcpToolCall(item, completed);

    case "reasoning": {
      if (!completed) return null;
      const text = pickString(item, "text");
      if (!text) return null;
      return { type: "assistant", subtype: "thinking", content: text };
    }

    default:
      return null;
  }
}

/**
 * `command_execution` is codex's shell tool. It arrives twice: `item.started`
 * with `status: "in_progress"` and an empty `aggregated_output`, then
 * `item.completed` with the output and an `exit_code`.
 */
function parseCodexCommand(
  item: Record<string, unknown>,
  completed: boolean,
): StreamMessage | null {
  const command = pickString(item, "command") ?? "";
  const id = pickString(item, "id");

  if (!completed) {
    const message: ToolUseMessage = {
      type: "tool_use",
      tool: "command_execution",
      content: command,
      toolInput: { command },
    };
    if (id) message.toolUseId = id;
    return message;
  }

  const output = pickString(item, "aggregated_output") ?? "";
  // ToolResultMessage has no `tool` field; the name and exit code ride along
  // in `meta` so consumers can pair a result with its call.
  const meta: Record<string, unknown> = { tool: "command_execution" };
  const exitCode = item.exit_code;
  if (typeof exitCode === "number") meta.exitCode = exitCode;
  const message: ToolResultMessage = {
    type: "tool_result",
    content: output,
    meta,
  };
  if (id) message.toolUseId = id;
  return message;
}

function parseCodexMcpToolCall(
  item: Record<string, unknown>,
  completed: boolean,
): StreamMessage | null {
  const tool = pickString(item, "tool") ?? pickString(item, "server") ?? "mcp_tool_call";
  const id = pickString(item, "id");

  if (!completed) {
    const args = asRecord(item.arguments);
    const message: ToolUseMessage = {
      type: "tool_use",
      tool,
      content: args ? JSON.stringify(args, null, 2) : tool,
    };
    if (args) message.toolInput = args;
    if (id) message.toolUseId = id;
    return message;
  }

  const result = item.result;
  const message: ToolResultMessage = {
    type: "tool_result",
    content: typeof result === "string" ? result : JSON.stringify(result ?? null),
    meta: { tool },
  };
  if (id) message.toolUseId = id;
  return message;
}

/**
 * `{"type":"turn.completed","usage":{…}}` — the end of a turn. Mapped to
 * `result` so downstream consumers see the same terminal event shape the
 * Claude adapter produces. `content` is empty because codex reports the final
 * text separately, in the preceding `agent_message` item.
 */
function parseCodexTurnCompleted(
  raw: Record<string, unknown>,
): StreamMessage | null {
  const message: ResultMessage = { type: "result", content: "" };
  const usage = extractCodexUsage(raw);
  if (usage) message.usage = usage;
  return message;
}

function parseCodexFailure(raw: Record<string, unknown>): StreamMessage | null {
  const error = asRecord(raw.error);
  const content =
    (error ? pickString(error, "message") : undefined) ??
    pickString(raw, "message") ??
    "codex turn failed";
  return { type: "error", content };
}

/**
 * codex usage keys: `input_tokens` / `cached_input_tokens` /
 * `cache_write_input_tokens` / `output_tokens` / `reasoning_output_tokens`.
 *
 * `input_tokens` is the **total** including the cached portion, matching
 * Claude's convention closely enough that no subtraction is applied.
 */
function extractCodexUsage(raw: Record<string, unknown>): TokenUsage | null {
  const usage = asRecord(raw.usage);
  if (!usage) return null;

  const inputTokens = pickNumber(usage, "input_tokens") ?? 0;
  const outputTokens = pickNumber(usage, "output_tokens") ?? 0;
  const cacheRead = pickNumber(usage, "cached_input_tokens");
  const cacheWrite = pickNumber(usage, "cache_write_input_tokens");

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    !cacheRead &&
    !cacheWrite
  ) {
    return null;
  }

  const result: TokenUsage = { inputTokens, outputTokens };
  if (cacheRead !== undefined && cacheRead > 0) result.cacheRead = cacheRead;
  if (cacheWrite !== undefined && cacheWrite > 0) result.cacheWrite = cacheWrite;
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
 * `codex exec` narrates on stderr during a perfectly healthy run. Without this
 * filter every session would raise an error event on its very first line.
 */
const CODEX_BENIGN_STDERR_PATTERNS: RegExp[] = [
  /Reading additional input from stdin/i,
];

export const codexAdapter: CLIAdapter = {
  command: process.env.CODEX_CLI_PATH ?? "codex",
  buildArgs: buildCodexArgs,
  parseOutput: parseCodexOutput,
  rateLimitPatterns: CODEX_RATE_LIMIT_PATTERNS,
  retryableErrorPatterns: CODEX_RETRYABLE_ERROR_PATTERNS,
  benignStderrPatterns: CODEX_BENIGN_STDERR_PATTERNS,
};
