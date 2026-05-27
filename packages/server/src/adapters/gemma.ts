import type { CLIAdapter, SessionOptions, StreamMessage } from "@synapse-chat/core";
import { parseStreamMessage } from "../stream-parser.js";
import { safeJsonParse } from "../util/json-safe.js";

export function buildGemmaArgs(options: SessionOptions): string[] {
  const args: string[] = [];
  const model = process.env.GEMMA_MODEL;
  if (model) {
    args.push("-m", model);
  }
  if (options.prompt) {
    args.push("-p", options.prompt);
  }
  return args;
}

export function parseGemmaOutput(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const raw = safeJsonParse<Record<string, unknown>>(trimmed, {
    source: "gemmaAdapter.parseOutput",
  });
  if (!raw) return null;
  return parseStreamMessage(raw);
}

export const gemmaAdapter: CLIAdapter = {
  command: process.env.GEMMA_CLI_PATH ?? "run_gemma4.sh",
  buildArgs: buildGemmaArgs,
  parseOutput: parseGemmaOutput,
  rateLimitPatterns: [],
  retryableErrorPatterns: [],
};
