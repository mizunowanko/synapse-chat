# Writing a CLI Adapter

A `CLIAdapter` is the small contract that lets `@synapse-chat/server` drive any AI CLI without knowing its specific argv flags or stdout grammar. This guide walks through the contract, the two adapters that ship in the box (Claude, Gemini), and how to author your own.

> **Type definitions**: [`@synapse-chat/core/cli-adapter.ts`](../packages/core/src/cli-adapter.ts).
> **Reference adapters**: [`adapters/claude.ts`](../packages/server/src/adapters/claude.ts), [`adapters/gemini.ts`](../packages/server/src/adapters/gemini.ts).

## The contract

```ts
export interface CLIAdapter {
  /** Executable name or absolute path. */
  readonly command: string;

  /** Translate generic SessionOptions into CLI-specific argv. */
  buildArgs(options: SessionOptions): string[];

  /** Parse a single stdout line into a StreamMessage, or null to skip. */
  parseOutput(line: string): StreamMessage | null;

  /** Format a user message for stdin (only needed for interactive CLIs). */
  formatInput?(message: string): string;

  /** Patterns that indicate a rate-limit error in stderr. */
  rateLimitPatterns: RegExp[];

  /** Patterns that indicate a transient error worth retrying. */
  retryableErrorPatterns: RegExp[];
}
```

Every adapter answers four questions about the underlying CLI:

1. **How do I launch it?** (`command`, `buildArgs`)
2. **How do I read its stdout?** (`parseOutput`)
3. **How do I write to its stdin?** (`formatInput`, optional)
4. **What stderr tells me to retry / back off?** (`rateLimitPatterns`, `retryableErrorPatterns`)

The framework deliberately stops there. Nothing about session lifecycle, prompts, or app semantics belongs in an adapter.

## Walkthrough: `claudeAdapter`

```ts
// packages/server/src/adapters/claude.ts
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
    "-p", options.prompt ?? "",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
  ];

  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.allowedTools?.length) args.push("--allowedTools", options.allowedTools.join(","));
  if (options.disallowedTools?.length) args.push("--disallowedTools", options.disallowedTools.join(","));
  if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);

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
```

What to notice:

- **`command` reads `process.env`**: the adapter falls back to a sensible default but lets the operator override the binary path. Mirror this pattern so deployments can swap to a wrapper script without recompiling.
- **`buildArgs` only reads `SessionOptions`**: no global state. Easy to unit-test by passing options in.
- **`parseOutput` is line-at-a-time**: assume the caller already handled buffering. Return `null` for lines you do not care about (init banners, hook chatter, blank lines) so the framework can drop them silently.
- **`formatInput` is optional**: omit it for one-shot CLIs that take their full input via argv. Provide it for CLIs that read additional turns over stdin (Claude's `--input-format stream-json` mode).
- **Rate-limit vs. retryable**: rate-limit patterns trigger `pm.emit("rate-limit", id)` so apps can pause / surface a banner. Retryable patterns are a superset — any line matching is treated as transient. Keep rate-limit precise to avoid false positives.

## Worked example: a fictional `myllm` CLI

Imagine a `myllm` CLI that:

- Reads a single prompt via `--input <text>`
- Streams JSON Lines on stdout shaped like `{"event":"text","data":"hi"}`
- Emits `{"event":"end"}` at completion
- Surfaces rate limits as `quota_exceeded` in stderr

A minimal adapter:

```ts
// adapters/myllm.ts
import type {
  CLIAdapter,
  SessionOptions,
  StreamMessage,
} from "@synapse-chat/core";
import { safeJsonParse } from "@synapse-chat/server";

const RATE_LIMIT = [/quota_exceeded/i];

export const myllmAdapter: CLIAdapter = {
  command: process.env.MYLLM_PATH ?? "myllm",

  buildArgs(opts: SessionOptions): string[] {
    return ["--input", opts.prompt ?? "", "--format", "jsonl"];
  },

  parseOutput(line: string): StreamMessage | null {
    const raw = safeJsonParse<{ event: string; data?: string }>(line, {
      source: "myllmAdapter.parseOutput",
    });
    if (!raw) return null;
    if (raw.event === "text") {
      return { type: "assistant", content: raw.data ?? "" };
    }
    if (raw.event === "end") {
      return { type: "result", content: "" };
    }
    return null;
  },

  rateLimitPatterns: RATE_LIMIT,
  retryableErrorPatterns: [...RATE_LIMIT, /ECONNRESET/, /\b5\d{2}\b/],
};
```

That is the entire contract. Wire it into a custom spawn:

```ts
import { spawn } from "node:child_process";
import { myllmAdapter } from "./adapters/myllm.js";

function runMyllm(prompt: string) {
  const args = myllmAdapter.buildArgs({ prompt });
  const proc = spawn(myllmAdapter.command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const msg = myllmAdapter.parseOutput(line);
      if (msg) handle(msg);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (myllmAdapter.rateLimitPatterns.some((re) => re.test(text))) {
      pauseUi();
    }
  });
}
```

For convenience, `attachStdoutProcessor()` from `@synapse-chat/server` does the buffering and JSON parsing in a single helper — pass it the adapter's `parseOutput` indirectly by adapting it to the `onMessage(raw)` callback shape.

## Testing tips

- **`buildArgs`**: snapshot the array for representative `SessionOptions`. Cheap and catches regressions in argv ordering, which downstream CLIs are picky about.
- **`parseOutput`**: feed it real captured lines (one fixture per event type). Bonus: feed garbage to make sure it returns `null` instead of throwing.
- **Rate-limit patterns**: assert against representative stderr blobs. The Claude / Gemini adapters do exactly this in `claude.test.ts` / `gemini.test.ts` — copy that pattern.

## Submitting an adapter back to synapse-chat

If your CLI is publicly available and broadly useful, we welcome adapters in `packages/server/src/adapters/`. The bar is:

1. Pure TypeScript — no runtime deps beyond `@synapse-chat/core` (and helpers re-exported from `@synapse-chat/server`).
2. A test file alongside (`<name>.test.ts`) covering `buildArgs`, `parseOutput`, and the rate-limit patterns.
3. A README mention in the "What's inside" table of [`packages/server/README.md`](../packages/server/README.md).
4. A changeset describing the new export.
