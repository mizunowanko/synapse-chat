import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildGemmaArgs, parseGemmaOutput, gemmaAdapter } from "./gemma.js";

describe("buildGemmaArgs", () => {
  let originalModel: string | undefined;
  let originalCLIPath: string | undefined;

  beforeEach(() => {
    originalModel = process.env.GEMMA_MODEL;
    originalCLIPath = process.env.GEMMA_CLI_PATH;
    delete process.env.GEMMA_MODEL;
    delete process.env.GEMMA_CLI_PATH;
  });

  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env.GEMMA_MODEL;
    } else {
      process.env.GEMMA_MODEL = originalModel;
    }
    if (originalCLIPath === undefined) {
      delete process.env.GEMMA_CLI_PATH;
    } else {
      process.env.GEMMA_CLI_PATH = originalCLIPath;
    }
  });

  it("returns empty args when no prompt and no model env var", () => {
    expect(buildGemmaArgs({})).toEqual([]);
  });

  it("adds -p when prompt is set", () => {
    expect(buildGemmaArgs({ prompt: "hello" })).toEqual(["-p", "hello"]);
  });

  it("adds -m from GEMMA_MODEL env var", () => {
    process.env.GEMMA_MODEL = "gemma4-light";
    expect(buildGemmaArgs({})).toEqual(["-m", "gemma4-light"]);
  });

  it("adds both -m and -p when both are present", () => {
    process.env.GEMMA_MODEL = "gemma4-heavy";
    expect(buildGemmaArgs({ prompt: "test" })).toEqual([
      "-m",
      "gemma4-heavy",
      "-p",
      "test",
    ]);
  });

  it("ignores non-gemma options like resumeSessionId or allowedTools", () => {
    const args = buildGemmaArgs({
      prompt: "hi",
      resumeSessionId: "sess-1",
      allowedTools: ["Read"],
      systemPrompt: "sys",
    });
    expect(args).toEqual(["-p", "hi"]);
  });
});

describe("parseGemmaOutput", () => {
  it("returns null for empty line", () => {
    expect(parseGemmaOutput("")).toBeNull();
    expect(parseGemmaOutput("   ")).toBeNull();
  });

  it("returns null for non-JSON line", () => {
    expect(parseGemmaOutput("not json")).toBeNull();
  });

  it("parses assistant message with text content block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello there!" }],
      },
    });
    const result = parseGemmaOutput(line);
    expect(result).toMatchObject({ type: "assistant", content: "Hello there!" });
  });

  it("parses result message", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Final answer",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const result = parseGemmaOutput(line);
    expect(result).toMatchObject({
      type: "result",
      content: "Final answer",
    });
  });

  it("returns null for result without result field", () => {
    const line = JSON.stringify({ type: "result", subtype: "success" });
    expect(parseGemmaOutput(line)).toBeNull();
  });

  it("returns null for unknown type", () => {
    const line = JSON.stringify({ type: "unknown_type", data: "foo" });
    expect(parseGemmaOutput(line)).toBeNull();
  });
});

describe("gemmaAdapter", () => {
  it("uses GEMMA_CLI_PATH env var when set", () => {
    const original = process.env.GEMMA_CLI_PATH;
    process.env.GEMMA_CLI_PATH = "/usr/local/bin/run_gemma4.sh";
    const adapter = { ...gemmaAdapter };
    expect(adapter.command).toBe("run_gemma4.sh");
    if (original === undefined) {
      delete process.env.GEMMA_CLI_PATH;
    } else {
      process.env.GEMMA_CLI_PATH = original;
    }
  });

  it("has empty rate limit and retryable error patterns", () => {
    expect(gemmaAdapter.rateLimitPatterns).toEqual([]);
    expect(gemmaAdapter.retryableErrorPatterns).toEqual([]);
  });
});
