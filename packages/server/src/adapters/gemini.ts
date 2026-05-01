import type { CLIAdapter, SessionOptions, StreamMessage, TokenUsage } from "@synapse-chat/core";

const GEMINI_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /RESOURCE_EXHAUSTED/,
  /quota/i,
];

const GEMINI_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  ...GEMINI_RATE_LIMIT_PATTERNS,
  /UNAVAILABLE/,
  /DEADLINE_EXCEEDED/,
  /INTERNAL/,
  /\b5\d{2}\b/,
  /ECONNRESET/,
  /ETIMEDOUT/,
];

export function buildGeminiArgs(options: SessionOptions): string[] {
  const args: string[] = [];
  if (options.prompt) {
    args.push("--prompt", options.prompt);
  }
  if (options.autoApprove) {
    args.push("--yolo");
  }
  return args;
}

export function parseGeminiOutput(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      const mapped = mapGeminiJsonToStreamMessage(raw);
      if (mapped) return mapped;
      return { type: "assistant", content: trimmed };
    } catch {
      return { type: "assistant", content: trimmed };
    }
  }

  return { type: "assistant", content: trimmed };
}

function mapGeminiJsonToStreamMessage(
  raw: Record<string, unknown>,
): StreamMessage | null {
  const functionCall = raw.functionCall ?? raw.toolUse;
  if (functionCall && typeof functionCall === "object") {
    const fc = functionCall as { name?: string; args?: Record<string, unknown>; input?: Record<string, unknown>; id?: string };
    const toolInput = fc.args ?? fc.input;
    const message: StreamMessage = {
      type: "tool_use",
      tool: fc.name ?? "tool",
      content: toolInput ? JSON.stringify(toolInput, null, 2) : (fc.name ?? "tool"),
    };
    if (toolInput) message.toolInput = toolInput;
    if (fc.id) message.toolUseId = fc.id;
    return message;
  }

  const functionResponse = raw.functionResponse ?? raw.toolResult;
  if (functionResponse && typeof functionResponse === "object") {
    const fr = functionResponse as { response?: unknown; content?: unknown; id?: string };
    const payload = fr.content ?? fr.response;
    const content =
      typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
    const message: StreamMessage = { type: "tool_result", content };
    if (fr.id) message.toolUseId = fr.id;
    return message;
  }

  if (raw.type === "result") {
    const result = (raw.result ?? raw.content ?? raw.text) as string | undefined;
    if (typeof result !== "string" || result.length === 0) return null;
    const message: StreamMessage = { type: "result", content: result };
    const usage = extractGeminiUsage(raw);
    if (usage) message.usage = usage;
    return message;
  }

  const text = raw.text ?? raw.content;
  if (typeof text === "string" && text.length > 0) {
    return { type: "assistant", content: text };
  }

  return null;
}

/**
 * Extract token usage from a Gemini `result`-shaped JSON payload.
 *
 * Accepts either Claude-style snake_case (`input_tokens` / `output_tokens` /
 * `cache_*_input_tokens`) or Gemini-style camelCase (`promptTokenCount`,
 * `candidatesTokenCount`, `cachedContentTokenCount`). Returns null when no
 * recognizable token fields are present.
 */
function extractGeminiUsage(
  raw: Record<string, unknown>,
): TokenUsage | null {
  const usage = (raw.usage ?? raw.usageMetadata) as
    | Record<string, unknown>
    | undefined;
  if (!usage || typeof usage !== "object") return null;

  const inputTokens =
    pickNumber(usage, "input_tokens") ??
    pickNumber(usage, "inputTokens") ??
    pickNumber(usage, "promptTokenCount") ??
    0;
  const outputTokens =
    pickNumber(usage, "output_tokens") ??
    pickNumber(usage, "outputTokens") ??
    pickNumber(usage, "candidatesTokenCount") ??
    0;
  const cacheRead =
    pickNumber(usage, "cache_read_input_tokens") ??
    pickNumber(usage, "cacheReadInputTokens") ??
    pickNumber(usage, "cachedContentTokenCount");
  const cacheWrite =
    pickNumber(usage, "cache_creation_input_tokens") ??
    pickNumber(usage, "cacheCreationInputTokens");

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return null;
  }

  const result: TokenUsage = { inputTokens, outputTokens };
  if (cacheRead !== undefined && cacheRead > 0) result.cacheRead = cacheRead;
  if (cacheWrite !== undefined && cacheWrite > 0) result.cacheWrite = cacheWrite;
  return result;
}

function pickNumber(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

export function formatGeminiInput(message: string): string {
  return message;
}

export const geminiAdapter: CLIAdapter = {
  command: process.env.GEMINI_CLI_PATH ?? "gemini",
  buildArgs: buildGeminiArgs,
  parseOutput: parseGeminiOutput,
  formatInput: formatGeminiInput,
  rateLimitPatterns: GEMINI_RATE_LIMIT_PATTERNS,
  retryableErrorPatterns: GEMINI_RETRYABLE_ERROR_PATTERNS,
};
