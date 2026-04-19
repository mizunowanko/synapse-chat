import { describe, expect, it } from "vitest";
import type {
  CLIAdapter,
  ImageAttachment,
  SessionOptions,
  StreamMessage,
} from "./index.js";

describe("@synapse-chat/core type surface", () => {
  it("StreamMessage accepts the stream-json shape", () => {
    const msg: StreamMessage = {
      type: "assistant",
      content: "hello",
      timestamp: 1_700_000_000_000,
    };
    expect(msg.type).toBe("assistant");
  });

  it("ImageAttachment narrows media type", () => {
    const img: ImageAttachment = { base64: "AAAA", mediaType: "image/png" };
    expect(img.mediaType).toBe("image/png");
  });

  it("CLIAdapter can be satisfied by a minimal implementation", () => {
    const adapter: CLIAdapter = {
      command: "echo",
      buildArgs: (opts: SessionOptions) => [opts.prompt ?? ""],
      parseOutput: (line) => (line.length === 0 ? null : { type: "assistant", content: line }),
      rateLimitPatterns: [/429/],
      retryableErrorPatterns: [/ECONNRESET/],
    };

    const parsed = adapter.parseOutput("hi");
    expect(parsed?.type).toBe("assistant");
    expect(parsed?.content).toBe("hi");
    expect(adapter.parseOutput("")).toBeNull();
    expect(adapter.buildArgs({ prompt: "hello" })).toEqual(["hello"]);
  });

  it("SessionOptions surfaces the expected fields", () => {
    const opts: SessionOptions = {
      prompt: "p",
      systemPrompt: "s",
      resumeSessionId: "abc",
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
      cwd: "/tmp",
      env: { FOO: "bar" },
    };
    expect(opts.env?.FOO).toBe("bar");
  });
});
