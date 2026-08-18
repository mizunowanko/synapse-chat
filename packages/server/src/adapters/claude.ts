import type { CLIAdapter, SessionOptions, StreamMessage } from "@synapse-chat/core";
import {
  parseStreamMessage,
  type ParseStreamMessageOptions,
} from "../stream-parser.js";
import { safeJsonParse } from "../util/json-safe.js";

const CLAUDE_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /rate_limit_error/i,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
];

const CLAUDE_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  ...CLAUDE_RATE_LIMIT_PATTERNS,
  /APIError.*429/i,
  /\b5\d{2}\b/,
  /internal.?server.?error/i,
  /service.?unavailable/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
];

export function buildClaudeArgs(options: SessionOptions): string[] {
  const args: string[] = [
    "-p",
    options.prompt ?? "",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
  ];

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }
  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }
  if (options.autoApprove) {
    args.push("--dangerously-skip-permissions");
  }
  // Token-level streaming. Only meaningful alongside the `stream-json` output
  // format already set above; the CLI rejects it otherwise.
  if (options.stream) {
    args.push("--include-partial-messages");
  }

  return args;
}

export function parseClaudeOutput(
  line: string,
  options: ParseStreamMessageOptions = {},
): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const raw = safeJsonParse<Record<string, unknown>>(trimmed, {
    source: "claudeAdapter.parseOutput",
  });
  if (!raw) return null;
  return parseStreamMessage(raw, options);
}

export function formatClaudeInput(message: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: message },
  });
}

export interface ClaudeAdapterOptions {
  /**
   * Parse `--include-partial-messages` output as token deltas.
   *
   * Must match the `stream` flag handed to {@link buildClaudeArgs} for the same
   * session: the flag decides what the CLI *emits*, this decides how the lines
   * are *read*. Setting one without the other either drops the deltas or
   * renders every sentence twice.
   */
  stream?: boolean;
}

/**
 * Build a Claude adapter bound to a parsing mode.
 *
 * A factory rather than a mutable singleton because one adapter can serve many
 * concurrent sessions; the mode has to be captured per instance, not stashed in
 * module state where a second session would inherit it.
 */
export function createClaudeAdapter(
  options: ClaudeAdapterOptions = {},
): CLIAdapter {
  const parseOptions: ParseStreamMessageOptions = {
    partialMessages: options.stream === true,
  };
  return {
    command: process.env.CLAUDE_CLI_PATH ?? "claude",
    buildArgs: buildClaudeArgs,
    parseOutput: (line) => parseClaudeOutput(line, parseOptions),
    formatInput: formatClaudeInput,
    rateLimitPatterns: CLAUDE_RATE_LIMIT_PATTERNS,
    retryableErrorPatterns: CLAUDE_RETRYABLE_ERROR_PATTERNS,
  };
}

/** Default instance — block-at-a-time parsing, unchanged from before #42. */
export const claudeAdapter: CLIAdapter = createClaudeAdapter();
