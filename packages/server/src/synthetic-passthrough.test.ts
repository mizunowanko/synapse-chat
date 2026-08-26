import { describe, it, expect } from "vitest";
import { parseStreamMessage, createStreamMessageParser } from "./stream-parser.js";

/**
 * Fixtures captured from `claude 2.1.212`. The `/clear` shape in particular is
 * the whole point of #44 — it was invented from the assumption "deltas always
 * come first", and only running the command showed that assumption was false.
 */
const messageStart = {
  type: "stream_event",
  event: { type: "message_start", message: { id: "msg_1" } },
};
const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
});
const thinkingDelta = (thinking: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
});
const finishedText = (text: string) => ({
  type: "assistant",
  message: { model: "claude-haiku-4-5", content: [{ type: "text", text }] },
});
const finishedThinking = (text: string) => ({
  type: "assistant",
  message: { model: "claude-haiku-4-5", content: [{ type: "thinking", text }] },
});
const result = { type: "result", subtype: "success", result: "" };

/** `/clear`: answered locally, so no `stream_event` is emitted at all. */
const syntheticReply = {
  type: "assistant",
  message: { model: "<synthetic>", content: [{ type: "text", text: "(no content)" }] },
};

describe("#44 差分を伴わない応答は捨てない", () => {
  it("/clear の合成応答が素通りする（先行する差分が無いので）", () => {
    const parse = createStreamMessageParser({ partialMessages: true });
    expect(parse({ type: "system", subtype: "init" })).toBeNull();
    expect(parse(syntheticReply)).toMatchObject({
      type: "assistant",
      content: "(no content)",
    });
  });

  it("直前のターンで差分が来ていても、次の合成応答は素通りする", () => {
    const parse = createStreamMessageParser({ partialMessages: true });
    parse(messageStart);
    parse(textDelta("あいう"));
    expect(parse(finishedText("あいう"))).toBeNull();
    parse(result); // ターン終了でリセット
    expect(parse(syntheticReply)).toMatchObject({ content: "(no content)" });
  });
});

describe("#44 通常のストリーミングは従来どおり", () => {
  it("差分が来た本文は完成側で二重にならない", () => {
    const parse = createStreamMessageParser({ partialMessages: true });
    parse(messageStart);
    expect(parse(textDelta("あい"))).toMatchObject({ content: "あい" });
    expect(parse(finishedText("あいうえお"))).toBeNull();
  });

  it("1 つの message_start に完成 assistant が 2 通来ても、両方とも抑制される", () => {
    // thinking ブロックと text ブロックで 2 行来る。完成行ごとにリセットすると
    // 2 通目が素通りして本文が二重になる（#44 で明示的に禁じたパターン）。
    const parse = createStreamMessageParser({ partialMessages: true });
    parse(messageStart);
    parse(thinkingDelta("考え"));
    parse(textDelta("答え"));
    expect(parse(finishedThinking("考え中…"))).toBeNull();
    expect(parse(finishedText("答えです"))).toBeNull();
  });

  it("thinking 差分だけでも、その後の完成 text は抑制される（同じメッセージなので）", () => {
    const parse = createStreamMessageParser({ partialMessages: true });
    parse(messageStart);
    parse(thinkingDelta("考え"));
    expect(parse(finishedText("答え"))).toBeNull();
  });
});

describe("#44 既定モードは不変", () => {
  it("差分を無視し、完成側を通す", () => {
    const parse = createStreamMessageParser();
    parse(messageStart);
    expect(parse(textDelta("あい"))).toBeNull();
    expect(parse(finishedText("あいうえお"))).toMatchObject({ content: "あいうえお" });
    expect(parse(syntheticReply)).toMatchObject({ content: "(no content)" });
  });
});

describe("#44 インスタンスは独立", () => {
  it("片方の状態がもう片方に漏れない", () => {
    const a = createStreamMessageParser({ partialMessages: true });
    const b = createStreamMessageParser({ partialMessages: true });
    a.call(null, messageStart);
    a.call(null, textDelta("x"));
    // b は差分を見ていないので、完成側を捨ててはいけない
    expect(b(finishedText("そのまま"))).toMatchObject({ content: "そのまま" });
  });
});

describe("#46 conversation_reset", () => {
  /** Verbatim from `claude 2.1.212` — ids and a timestamp, no text. */
  const reset = {
    type: "conversation_reset",
    new_conversation_id: "dc9494eb-60a4-4e6c-bcc1-2c5277841a11",
    session_id: "3878f0aa-8fd6-4df5-9b40-8535ae295d26",
    uuid: "850570dd-8d91-441e-af31-028d664c5108",
    timestamp: 1787785152666,
  };

  it("通す（消費側が描くかどうかは別の判断）", () => {
    expect(parseStreamMessage(reset)).toMatchObject({
      type: "system",
      subtype: "conversation-reset",
    });
  });

  it("partial モードでも通る", () => {
    const parse = createStreamMessageParser({ partialMessages: true });
    expect(parse(reset)).toMatchObject({ type: "system", subtype: "conversation-reset" });
  });

  it("本文は持たない（ラベルは消費側が subtype から引く）", () => {
    expect((parseStreamMessage(reset) as { content?: string })?.content).toBe("");
  });
});
