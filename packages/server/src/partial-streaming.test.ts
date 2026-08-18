import { describe, it, expect } from "vitest";
import { parseStreamMessage } from "./stream-parser.js";
import { buildClaudeArgs, createClaudeAdapter } from "./adapters/index.js";

/**
 * Fixtures are verbatim lines captured from `claude 2.1.212` run with
 * `--output-format stream-json --include-partial-messages --verbose` (#42).
 * Hand-written approximations would not have caught that the finished
 * `assistant` message arrives *in addition to* the deltas.
 */
const textDelta = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "申し訳ありませんが、" },
  },
  session_id: "e39e396f",
  parent_tool_use_id: null,
};

const thinkingDelta = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "The user has" },
  },
  session_id: "e39e396f",
  parent_tool_use_id: null,
};

const signatureDelta = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "EpgGCqgBCBAYAipA" },
  },
};

const lifecycle = [
  { type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } },
  { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
  { type: "stream_event", event: { type: "message_stop" } },
];

/** The finished message the CLI emits *as well as* the deltas above. */
const finishedText = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "申し訳ありませんが、メッセージが短すぎます。" }] },
};
const finishedThinking = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "thinking", text: "The user has written…" }] },
};
const finishedToolUse = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
  },
};

describe("stream_event deltas (partial mode)", () => {
  const partial = { partialMessages: true };
  it("turns text_delta into a plain assistant delta", () => {
    expect(parseStreamMessage(textDelta, partial)).toMatchObject({
      type: "assistant",
      content: "申し訳ありませんが、",
    });
    expect(parseStreamMessage(textDelta, partial)?.subtype).toBeUndefined();
  });

  it("turns thinking_delta into a thinking delta", () => {
    expect(parseStreamMessage(thinkingDelta, partial)).toMatchObject({
      type: "assistant",
      subtype: "thinking",
      content: "The user has",
    });
  });

  it("drops signature_delta — it is a cryptographic blob, not prose", () => {
    expect(parseStreamMessage(signatureDelta, partial)).toBeNull();
  });

  it("drops every lifecycle event", () => {
    for (const raw of lifecycle) expect(parseStreamMessage(raw, partial)).toBeNull();
  });

  it("drops empty deltas rather than emitting blank bubbles", () => {
    const empty = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } } };
    expect(parseStreamMessage(empty, partial)).toBeNull();
  });
});

describe("no double delivery in partial mode", () => {
  const partial = { partialMessages: true };

  it("suppresses the finished text — the deltas already carried it", () => {
    expect(parseStreamMessage(finishedText, partial)).toBeNull();
  });

  it("suppresses the finished thinking", () => {
    expect(parseStreamMessage(finishedThinking, partial)).toBeNull();
  });

  it("still emits tool_use once, since its input never arrives as usable deltas", () => {
    expect(parseStreamMessage(finishedToolUse, partial)).toMatchObject({
      type: "tool_use",
      tool: "Bash",
      toolUseId: "toolu_1",
    });
  });
});

describe("default mode is byte-for-byte unchanged", () => {
  it("ignores stream_event entirely — reading both would double every sentence", () => {
    expect(parseStreamMessage(textDelta)).toBeNull();
    expect(parseStreamMessage(thinkingDelta)).toBeNull();
  });

  it("still emits finished text", () => {
    expect(parseStreamMessage(finishedText)).toMatchObject({
      type: "assistant",
      content: "申し訳ありませんが、メッセージが短すぎます。",
    });
  });

  it("still emits finished thinking", () => {
    expect(parseStreamMessage(finishedThinking)).toMatchObject({
      type: "assistant",
      subtype: "thinking",
    });
  });

  it("still emits tool_use", () => {
    expect(parseStreamMessage(finishedToolUse)).toMatchObject({ type: "tool_use", tool: "Bash" });
  });
});

describe("argv", () => {
  it("adds --include-partial-messages only when stream is on", () => {
    expect(buildClaudeArgs({ prompt: "hi", stream: true })).toContain("--include-partial-messages");
    expect(buildClaudeArgs({ prompt: "hi" })).not.toContain("--include-partial-messages");
    expect(buildClaudeArgs({ prompt: "hi", stream: false })).not.toContain("--include-partial-messages");
  });

  it("keeps stream-json, which the partial flag requires", () => {
    const args = buildClaudeArgs({ prompt: "hi", stream: true });
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  });
});

describe("createClaudeAdapter binds the parsing mode per instance", () => {
  it("a streaming instance reads deltas and drops finished prose", () => {
    const a = createClaudeAdapter({ stream: true });
    expect(a.parseOutput(JSON.stringify(textDelta))).toMatchObject({ content: "申し訳ありませんが、" });
    expect(a.parseOutput(JSON.stringify(finishedText))).toBeNull();
  });

  it("a default instance ignores deltas' twin and keeps finished prose", () => {
    const a = createClaudeAdapter();
    expect(a.parseOutput(JSON.stringify(finishedText))).toMatchObject({ type: "assistant" });
  });

  it("two instances do not share mode — one session must not infect another", () => {
    const streaming = createClaudeAdapter({ stream: true });
    const plain = createClaudeAdapter();
    expect(streaming.parseOutput(JSON.stringify(finishedText))).toBeNull();
    expect(plain.parseOutput(JSON.stringify(finishedText))).not.toBeNull();
  });
});
