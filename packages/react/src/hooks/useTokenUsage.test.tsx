import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { StreamMessage } from "@synapse-chat/core";
import { useTokenUsage } from "./useTokenUsage.js";

describe("useTokenUsage", () => {
  it("returns all-zero totals for an empty list", () => {
    const { result } = renderHook(() => useTokenUsage([]));
    expect(result.current).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      resultCount: 0,
    });
  });

  it("sums usage across multiple result messages", () => {
    const messages: StreamMessage[] = [
      {
        type: "result",
        content: "first",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheRead: 10,
          cacheWrite: 5,
        },
      },
      {
        type: "result",
        content: "second",
        usage: { inputTokens: 200, outputTokens: 80 },
      },
    ];
    const { result } = renderHook(() => useTokenUsage(messages));
    expect(result.current).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheRead: 10,
      cacheWrite: 5,
      resultCount: 2,
    });
  });

  it("ignores result messages without usage", () => {
    const messages: StreamMessage[] = [
      { type: "result", content: "no usage" },
      {
        type: "result",
        content: "with usage",
        usage: { inputTokens: 7, outputTokens: 3 },
      },
    ];
    const { result } = renderHook(() => useTokenUsage(messages));
    expect(result.current).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheRead: 0,
      cacheWrite: 0,
      resultCount: 1,
    });
  });

  it("ignores non-result messages even when they carry a usage field", () => {
    const messages: StreamMessage[] = [
      { type: "assistant", content: "hi" },
      {
        type: "user",
        content: "smuggled",
        usage: { inputTokens: 999, outputTokens: 999 },
      },
    ];
    const { result } = renderHook(() => useTokenUsage(messages));
    expect(result.current.resultCount).toBe(0);
    expect(result.current.inputTokens).toBe(0);
  });

  it("re-derives when the messages array reference changes", () => {
    const initial: StreamMessage[] = [
      {
        type: "result",
        content: "a",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: StreamMessage[] }) => useTokenUsage(msgs),
      { initialProps: { msgs: initial } },
    );
    expect(result.current.inputTokens).toBe(1);

    const next: StreamMessage[] = [
      ...initial,
      {
        type: "result",
        content: "b",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ];
    rerender({ msgs: next });
    expect(result.current).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cacheRead: 0,
      cacheWrite: 0,
      resultCount: 2,
    });
  });
});
