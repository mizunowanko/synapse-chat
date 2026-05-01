import type { CLIAdapter, SessionOptions, StreamMessage } from "@synapse-chat/core";

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

  const text = raw.text ?? raw.content;
  if (typeof text === "string" && text.length > 0) {
    return { type: "assistant", content: text };
  }

  return null;
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
