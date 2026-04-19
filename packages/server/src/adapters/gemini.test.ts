import { describe, it, expect } from "vitest";
import {
  buildGeminiArgs,
  parseGeminiOutput,
  formatGeminiInput,
  geminiAdapter,
} from "./gemini.js";

describe("buildGeminiArgs", () => {
  it("adds --prompt when prompt is set", () => {
    expect(buildGeminiArgs({ prompt: "hello" })).toEqual(["--prompt", "hello"]);
  });

  it("returns empty args when no prompt", () => {
    expect(buildGeminiArgs({})).toEqual([]);
  });

  it("ignores Claude-only options (resume, allowedTools, ...)", () => {
    const args = buildGeminiArgs({
      prompt: "hi",
      resumeSessionId: "sess-1",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      systemPrompt: "sys",
    });
    expect(args).toEqual(["--prompt", "hi"]);
  });
});

describe("parseGeminiOutput", () => {
  it("returns null for empty or whitespace-only line", () => {
    expect(parseGeminiOutput("")).toBeNull();
    expect(parseGeminiOutput("  \t  ")).toBeNull();
  });

  it("wraps plain text as assistant message", () => {
    expect(parseGeminiOutput("Hello, world.")).toEqual({
      type: "assistant",
      content: "Hello, world.",
    });
  });

  it("extracts text field from JSON payload", () => {
    const line = JSON.stringify({ text: "response body" });
    expect(parseGeminiOutput(line)).toEqual({
      type: "assistant",
      content: "response body",
    });
  });

  it("extracts content field from JSON payload", () => {
    const line = JSON.stringify({ content: "alt field" });
    expect(parseGeminiOutput(line)).toEqual({
      type: "assistant",
      content: "alt field",
    });
  });

  it("maps functionCall to tool_use", () => {
    const line = JSON.stringify({
      functionCall: {
        id: "call_1",
        name: "fetchData",
        args: { url: "https://example.com" },
      },
    });
    const msg = parseGeminiOutput(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_use");
    expect(msg!.tool).toBe("fetchData");
    expect(msg!.toolUseId).toBe("call_1");
    expect(msg!.toolInput).toEqual({ url: "https://example.com" });
  });

  it("maps toolUse (camelCase alias) to tool_use", () => {
    const line = JSON.stringify({
      toolUse: { name: "Search", input: { q: "x" } },
    });
    const msg = parseGeminiOutput(line);
    expect(msg?.type).toBe("tool_use");
    expect(msg?.tool).toBe("Search");
    expect(msg?.toolInput).toEqual({ q: "x" });
  });

  it("maps functionResponse to tool_result", () => {
    const line = JSON.stringify({
      functionResponse: { id: "call_1", response: "ok" },
    });
    expect(parseGeminiOutput(line)).toEqual({
      type: "tool_result",
      content: "ok",
      toolUseId: "call_1",
    });
  });

  it("maps toolResult with structured payload to tool_result", () => {
    const line = JSON.stringify({
      toolResult: { content: { data: [1, 2, 3] } },
    });
    const msg = parseGeminiOutput(line);
    expect(msg?.type).toBe("tool_result");
    expect(msg?.content).toBe(JSON.stringify({ data: [1, 2, 3] }));
  });

  it("falls back to raw JSON string when no known fields", () => {
    const line = JSON.stringify({ unknown: "shape" });
    expect(parseGeminiOutput(line)).toEqual({
      type: "assistant",
      content: line,
    });
  });

  it("treats malformed JSON-looking text as assistant content", () => {
    expect(parseGeminiOutput("{malformed")).toEqual({
      type: "assistant",
      content: "{malformed",
    });
  });

  it("supports arrays (treated as assistant raw content)", () => {
    const line = JSON.stringify([1, 2, 3]);
    expect(parseGeminiOutput(line)).toEqual({
      type: "assistant",
      content: line,
    });
  });
});

describe("formatGeminiInput", () => {
  it("returns the message unchanged", () => {
    expect(formatGeminiInput("hi")).toBe("hi");
  });

  it("preserves empty messages", () => {
    expect(formatGeminiInput("")).toBe("");
  });
});

describe("geminiAdapter error patterns", () => {
  const match = (patterns: RegExp[], text: string) =>
    patterns.some((p) => p.test(text));

  it("rateLimitPatterns match RESOURCE_EXHAUSTED", () => {
    expect(match(geminiAdapter.rateLimitPatterns, "RESOURCE_EXHAUSTED: quota")).toBe(true);
  });

  it("rateLimitPatterns match 429", () => {
    expect(match(geminiAdapter.rateLimitPatterns, "HTTP 429")).toBe(true);
  });

  it("rateLimitPatterns match quota", () => {
    expect(match(geminiAdapter.rateLimitPatterns, "Daily quota exceeded")).toBe(true);
  });

  it("retryableErrorPatterns match UNAVAILABLE / DEADLINE_EXCEEDED / INTERNAL", () => {
    expect(match(geminiAdapter.retryableErrorPatterns, "Status: UNAVAILABLE")).toBe(true);
    expect(match(geminiAdapter.retryableErrorPatterns, "DEADLINE_EXCEEDED")).toBe(true);
    expect(match(geminiAdapter.retryableErrorPatterns, "INTERNAL server error")).toBe(true);
  });

  it("retryableErrorPatterns include rate-limit patterns", () => {
    expect(match(geminiAdapter.retryableErrorPatterns, "429")).toBe(true);
  });

  it("retryableErrorPatterns do not match unrelated errors", () => {
    expect(match(geminiAdapter.retryableErrorPatterns, "PERMISSION_DENIED")).toBe(false);
  });
});

describe("geminiAdapter metadata", () => {
  it("exposes command from env or default", () => {
    expect(typeof geminiAdapter.command).toBe("string");
    expect(geminiAdapter.command.length).toBeGreaterThan(0);
  });

  it("exposes formatInput as an optional method", () => {
    expect(typeof geminiAdapter.formatInput).toBe("function");
  });
});
