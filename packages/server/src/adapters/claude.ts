import type { CLIAdapter, SessionOptions, StreamMessage } from "@synapse-chat/core";
import { parseStreamMessage } from "../stream-parser.js";
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

  return args;
}

export function parseClaudeOutput(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const raw = safeJsonParse<Record<string, unknown>>(trimmed, {
    source: "claudeAdapter.parseOutput",
  });
  if (!raw) return null;
  return parseStreamMessage(raw);
}

export function formatClaudeInput(message: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: message },
  });
}

export const claudeAdapter: CLIAdapter = {
  command: process.env.CLAUDE_CLI_PATH ?? "claude",
  buildArgs: buildClaudeArgs,
  parseOutput: parseClaudeOutput,
  formatInput: formatClaudeInput,
  rateLimitPatterns: CLAUDE_RATE_LIMIT_PATTERNS,
  retryableErrorPatterns: CLAUDE_RETRYABLE_ERROR_PATTERNS,
};
