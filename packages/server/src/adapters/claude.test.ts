import { describe, it, expect } from "vitest";
import {
  buildClaudeArgs,
  parseClaudeOutput,
  formatClaudeInput,
  claudeAdapter,
} from "./claude.js";

describe("buildClaudeArgs", () => {
  it("includes base flags when only prompt is supplied", () => {
    const args = buildClaudeArgs({ prompt: "hello" });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("uses empty -p payload when prompt is absent (interactive mode)", () => {
    const args = buildClaudeArgs({});
    expect(args.slice(0, 2)).toEqual(["-p", ""]);
  });

  it("appends --resume when resumeSessionId is set", () => {
    const args = buildClaudeArgs({ resumeSessionId: "sess-123" });
    expect(args).toContain("--resume");
    const idx = args.indexOf("--resume");
    expect(args[idx + 1]).toBe("sess-123");
  });

  it("joins allowedTools with comma", () => {
    const args = buildClaudeArgs({ allowedTools: ["Read", "Bash", "Glob"] });
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read,Bash,Glob");
  });

  it("omits --allowedTools when list is empty", () => {
    const args = buildClaudeArgs({ allowedTools: [] });
    expect(args).not.toContain("--allowedTools");
  });

  it("joins disallowedTools with comma", () => {
    const args = buildClaudeArgs({
      disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    });
    const idx = args.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("EnterPlanMode,ExitPlanMode");
  });

  it("omits --disallowedTools when list is empty", () => {
    const args = buildClaudeArgs({ disallowedTools: [] });
    expect(args).not.toContain("--disallowedTools");
  });

  it("appends --append-system-prompt when systemPrompt is set", () => {
    const args = buildClaudeArgs({ systemPrompt: "You are helpful." });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("You are helpful.");
  });

  it("combines every option in a single invocation", () => {
    const args = buildClaudeArgs({
      prompt: "run",
      systemPrompt: "sys",
      resumeSessionId: "abc",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    });
    expect(args).toContain("--resume");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("--append-system-prompt");
  });
});

describe("parseClaudeOutput", () => {
  it("returns null for empty line", () => {
    expect(parseClaudeOutput("")).toBeNull();
    expect(parseClaudeOutput("   \n  ")).toBeNull();
  });

  it("delegates assistant stream-json to parseStreamMessage", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    });
    const msg = parseClaudeOutput(line);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.content).toBe("Hi");
    expect(typeof msg!.timestamp).toBe("number");
  });

  it("returns null for init system messages (internal bookkeeping)", () => {
    const line = JSON.stringify({ type: "system", subtype: "init" });
    expect(parseClaudeOutput(line)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseClaudeOutput("not-json{")).toBeNull();
  });

  it("parses tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Read",
            input: { file_path: "/a" },
          },
        ],
      },
    });
    const msg = parseClaudeOutput(line);
    expect(msg?.type).toBe("tool_use");
    expect(msg?.tool).toBe("Read");
    expect(msg?.toolUseId).toBe("tu_1");
  });
});

describe("formatClaudeInput", () => {
  it("produces stream-json envelope", () => {
    const json = formatClaudeInput("hello");
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
    });
  });

  it("handles empty messages", () => {
    expect(JSON.parse(formatClaudeInput(""))).toEqual({
      type: "user",
      message: { role: "user", content: "" },
    });
  });

  it("does not append a trailing newline (caller controls framing)", () => {
    expect(formatClaudeInput("x").endsWith("\n")).toBe(false);
  });
});

describe("claudeAdapter error patterns", () => {
  const match = (patterns: RegExp[], text: string) =>
    patterns.some((p) => p.test(text));

  it("rateLimitPatterns match 429", () => {
    expect(match(claudeAdapter.rateLimitPatterns, "HTTP 429 Too Many Requests")).toBe(true);
  });

  it("rateLimitPatterns match rate_limit_error", () => {
    expect(match(claudeAdapter.rateLimitPatterns, '{"error":"rate_limit_error"}')).toBe(true);
  });

  it("rateLimitPatterns match overloaded", () => {
    expect(match(claudeAdapter.rateLimitPatterns, "Server overloaded, retry later")).toBe(true);
  });

  it("retryableErrorPatterns include rate limit patterns", () => {
    expect(match(claudeAdapter.retryableErrorPatterns, "429 Too many requests")).toBe(true);
  });

  it("retryableErrorPatterns match 5xx", () => {
    expect(match(claudeAdapter.retryableErrorPatterns, "HTTP 503 Service Unavailable")).toBe(true);
    expect(match(claudeAdapter.retryableErrorPatterns, "got 500 Internal Server Error")).toBe(true);
  });

  it("retryableErrorPatterns match ECONNRESET / ETIMEDOUT", () => {
    expect(match(claudeAdapter.retryableErrorPatterns, "connect ECONNRESET 1.2.3.4:443")).toBe(true);
    expect(match(claudeAdapter.retryableErrorPatterns, "request ETIMEDOUT")).toBe(true);
  });

  it("retryableErrorPatterns do not match unrelated errors", () => {
    expect(match(claudeAdapter.retryableErrorPatterns, "ENOENT: file not found")).toBe(false);
  });
});

describe("claudeAdapter metadata", () => {
  it("respects CLAUDE_CLI_PATH env default", () => {
    expect(typeof claudeAdapter.command).toBe("string");
    expect(claudeAdapter.command.length).toBeGreaterThan(0);
  });

  it("exposes formatInput as an optional method", () => {
    expect(typeof claudeAdapter.formatInput).toBe("function");
  });
});
