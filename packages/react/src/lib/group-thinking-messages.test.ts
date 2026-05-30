import { describe, it, expect } from "vitest";
import type { StreamMessage } from "@synapse-chat/core";
import { groupThinkingMessages } from "./group-thinking-messages.js";
import {
  isThinkingGroup,
  isToolGroup,
  type DisplayItem,
  type ThinkingGroupItem,
  type ToolUseGroupItem,
} from "./group-tool-messages.js";

function thinkingMsg(content: string, extra?: Partial<StreamMessage>): StreamMessage {
  return {
    type: "assistant",
    subtype: "thinking",
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

function assistantMsg(content: string, extra?: Partial<StreamMessage>): StreamMessage {
  return { type: "assistant", content, timestamp: Date.now(), ...extra };
}

describe("groupThinkingMessages", () => {
  it("returns empty array for empty input", () => {
    expect(groupThinkingMessages([])).toEqual([]);
  });

  it("passes non-thinking items through untouched", () => {
    const input: DisplayItem[] = [assistantMsg("hi"), assistantMsg("there")];
    expect(groupThinkingMessages(input)).toEqual(input);
  });

  it("folds consecutive thinking chunks into a single group", () => {
    const input: DisplayItem[] = [
      thinkingMsg("Let me "),
      thinkingMsg("think "),
      thinkingMsg("about this."),
      assistantMsg("Done!"),
    ];
    const result = groupThinkingMessages(input);
    expect(result).toHaveLength(2);
    expect(isThinkingGroup(result[0]!)).toBe(true);
    const group = result[0] as ThinkingGroupItem;
    expect(group.content).toBe("Let me think about this.");
    expect(group.isComplete).toBe(true);
    expect((result[1] as StreamMessage).type).toBe("assistant");
  });

  it("marks the trailing thinking group as incomplete when nothing follows", () => {
    const input: DisplayItem[] = [
      thinkingMsg("still "),
      thinkingMsg("reasoning"),
    ];
    const result = groupThinkingMessages(input);
    expect(result).toHaveLength(1);
    const group = result[0] as ThinkingGroupItem;
    expect(group.isComplete).toBe(false);
    expect(group.content).toBe("still reasoning");
  });

  it("splits groups around interleaving content", () => {
    const input: DisplayItem[] = [
      thinkingMsg("first"),
      assistantMsg("hello"),
      thinkingMsg("second"),
      assistantMsg("world"),
    ];
    const result = groupThinkingMessages(input);
    expect(result).toHaveLength(4);
    expect(isThinkingGroup(result[0]!)).toBe(true);
    expect((result[0] as ThinkingGroupItem).isComplete).toBe(true);
    expect(isThinkingGroup(result[2]!)).toBe(true);
    expect((result[2] as ThinkingGroupItem).isComplete).toBe(true);
  });

  it("preserves the timestamp of the first thinking chunk in the group", () => {
    const ts = 1700000000000;
    const input: DisplayItem[] = [
      thinkingMsg("a", { timestamp: ts }),
      thinkingMsg("b", { timestamp: ts + 100 }),
      assistantMsg("end"),
    ];
    const result = groupThinkingMessages(input);
    expect((result[0] as ThinkingGroupItem).timestamp).toBe(ts);
  });

  it("treats tool groups as non-thinking and completes any preceding group", () => {
    const toolGroup: ToolUseGroupItem = { kind: "tool-group", messages: [] };
    const input: DisplayItem[] = [thinkingMsg("planning"), toolGroup];
    const result = groupThinkingMessages(input);
    expect(result).toHaveLength(2);
    expect(isThinkingGroup(result[0]!)).toBe(true);
    expect((result[0] as ThinkingGroupItem).isComplete).toBe(true);
    expect(isToolGroup(result[1]!)).toBe(true);
  });

  it("passes already-folded thinking groups through untouched", () => {
    const existing: ThinkingGroupItem = {
      kind: "thinking-group",
      content: "pre-folded",
      isComplete: true,
    };
    const input: DisplayItem[] = [existing, assistantMsg("ok")];
    const result = groupThinkingMessages(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(existing);
  });
});

describe("isThinkingGroup", () => {
  it("returns true for ThinkingGroupItem", () => {
    const item: ThinkingGroupItem = {
      kind: "thinking-group",
      content: "",
      isComplete: false,
    };
    expect(isThinkingGroup(item)).toBe(true);
  });

  it("returns false for StreamMessage", () => {
    expect(isThinkingGroup(assistantMsg("x") as DisplayItem)).toBe(false);
  });

  it("returns false for ToolUseGroupItem", () => {
    const item: ToolUseGroupItem = { kind: "tool-group", messages: [] };
    expect(isThinkingGroup(item)).toBe(false);
  });
});
