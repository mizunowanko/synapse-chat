import { describe, it, expect } from "vitest";
import type { StreamMessage } from "@synapse-chat/core";
import { createMessageFilter } from "./message-filters.js";

type Context = "ship" | "command";

const filter = createMessageFilter<Context>({
  rules: [
    { subtype: "status", contexts: ["ship", "command"] },
    { subtype: "command-only", contexts: ["command"] },
  ],
  hideUserInContexts: ["ship"],
  metaCategoryContexts: {
    "escort-log": ["ship"],
  },
});

describe("createMessageFilter", () => {
  it("keeps rendered user/assistant messages in command context", () => {
    const msgs: StreamMessage[] = [
      { type: "user", content: "hi" },
      { type: "assistant", content: "hello" },
    ];
    expect(filter(msgs, "command")).toEqual(msgs);
  });

  it("hides user messages in ship context", () => {
    const msgs: StreamMessage[] = [
      { type: "user", content: "hi" },
      { type: "assistant", content: "hello" },
    ];
    expect(filter(msgs, "ship")).toEqual([
      { type: "assistant", content: "hello" },
    ]);
  });

  it("applies rule table for system messages", () => {
    const msgs: StreamMessage[] = [
      { type: "system", subtype: "status", content: "ok" },
      { type: "system", subtype: "command-only", content: "hi" },
    ];
    expect(filter(msgs, "ship")).toEqual([
      { type: "system", subtype: "status", content: "ok" },
    ]);
    expect(filter(msgs, "command")).toHaveLength(2);
  });

  it("drops unknown system subtype by default", () => {
    const msgs: StreamMessage[] = [
      { type: "system", subtype: "mystery", content: "?" },
    ];
    expect(filter(msgs, "command")).toEqual([]);
  });

  it("keeps unknown system subtype when dropUnknownSystem is false", () => {
    const keepFilter = createMessageFilter({
      rules: [],
      dropUnknownSystem: false,
    });
    const msgs: StreamMessage[] = [
      { type: "system", subtype: "mystery", content: "?" },
    ];
    expect(keepFilter(msgs, "any" as string)).toEqual(msgs);
  });

  it("honours metaCategoryContexts for non-system messages", () => {
    const msgs: StreamMessage[] = [
      { type: "assistant", content: "log line", meta: { category: "escort-log" } },
    ];
    expect(filter(msgs, "ship")).toEqual(msgs);
    expect(filter(msgs, "command")).toEqual([]);
  });

  it("drops non-system, non-tool_use messages without content", () => {
    const msgs: StreamMessage[] = [
      { type: "assistant" },
      { type: "tool_use", tool: "Bash" },
    ];
    const result = filter(msgs, "command");
    expect(result).toEqual([{ type: "tool_use", tool: "Bash" }]);
  });

  it("tolerates null entries", () => {
    const msgs = [
      null as unknown as StreamMessage,
      { type: "assistant", content: "ok" } satisfies StreamMessage,
    ];
    expect(filter(msgs, "command")).toEqual([
      { type: "assistant", content: "ok" },
    ]);
  });

  it("treats undefined meta.category as no category", () => {
    const msgs: StreamMessage[] = [
      { type: "assistant", content: "ok", meta: { other: 1 } },
    ];
    expect(filter(msgs, "command")).toEqual(msgs);
  });
});
