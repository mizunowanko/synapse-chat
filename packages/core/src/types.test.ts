import { describe, expect, it } from "vitest";
import { assertNever, isAssistantBody, isThinkingMessage } from "./index.js";
import type {
  Attachment,
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

  it("discriminates a plain assistant body delta from a thinking chunk", () => {
    const body: StreamMessage = { type: "assistant", content: "hi" };
    const thinking: StreamMessage = {
      type: "assistant",
      subtype: "thinking",
      content: "reasoning",
    };

    expect(isAssistantBody(body)).toBe(true);
    expect(isThinkingMessage(body)).toBe(false);
    expect(isAssistantBody(thinking)).toBe(false);
    expect(isThinkingMessage(thinking)).toBe(true);
  });

  it("narrows result usage through the discriminant", () => {
    const msg: StreamMessage = {
      type: "result",
      content: "done",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    // Exhaustive branch: only `result` carries `usage`.
    if (msg.type === "result") {
      expect(msg.usage?.inputTokens).toBe(10);
    }
  });

  it("assertNever throws when reached at runtime", () => {
    expect(() => assertNever("unexpected" as never)).toThrow(
      /Unhandled StreamMessage variant/,
    );
  });

  it("ImageAttachment narrows media type", () => {
    const img: ImageAttachment = {
      kind: "image",
      base64: "AAAA",
      mediaType: "image/png",
    };
    expect(img.mediaType).toBe("image/png");
  });

  it("Attachment discriminates image vs text on `kind`", () => {
    const attachments: Attachment[] = [
      { kind: "image", base64: "AAAA", mediaType: "image/png", name: "a.png" },
      { kind: "text", content: "hello", mimeType: "text/plain", name: "n.txt" },
    ];
    const summary = attachments.map((a) =>
      a.kind === "image" ? a.mediaType : a.mimeType,
    );
    expect(summary).toEqual(["image/png", "text/plain"]);
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
