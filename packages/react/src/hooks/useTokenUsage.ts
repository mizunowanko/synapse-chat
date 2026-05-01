import { useMemo } from "react";
import type { StreamMessage } from "@synapse-chat/core";

/**
 * Cumulative token usage derived from a list of {@link StreamMessage}s.
 *
 * Cache fields default to zero (rather than being omitted) so consumers can
 * read them without null-checks. `resultCount` is the number of `result`
 * messages whose `usage` was summed — useful for averaging or detecting that
 * no usage data has arrived yet.
 */
export interface CumulativeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  resultCount: number;
}

/**
 * Sum {@link StreamMessage.usage} across `result` messages to produce the
 * session's cumulative token count.
 *
 * Pass the `messages` array returned by {@link useChat} (or any per-session
 * StreamMessage list). The hook is a pure derivation memoized on the array
 * reference, so it re-computes only when `useChat` produces a new array.
 *
 * Messages without `usage` and non-`result` messages are ignored.
 */
export function useTokenUsage(
  messages: readonly StreamMessage[],
): CumulativeTokenUsage {
  return useMemo(() => {
    const totals: CumulativeTokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      resultCount: 0,
    };
    for (const msg of messages) {
      if (msg.type !== "result") continue;
      const usage = msg.usage;
      if (!usage) continue;
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.cacheRead += usage.cacheRead ?? 0;
      totals.cacheWrite += usage.cacheWrite ?? 0;
      totals.resultCount += 1;
    }
    return totals;
  }, [messages]);
}
