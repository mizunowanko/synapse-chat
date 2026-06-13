import { isThinkingMessage } from "@synapse-chat/core";
import {
  isThinkingGroup,
  isToolGroup,
  type DisplayItem,
  type ThinkingGroupItem,
} from "./group-tool-messages.js";

/**
 * Fold consecutive `assistant + subtype:"thinking"` messages into a single
 * {@link ThinkingGroupItem}. Other items (`tool-group`, plain
 * StreamMessages, already-folded thinking groups) pass through untouched.
 *
 * A group is marked `isComplete: true` when at least one non-thinking item
 * follows it in the input. The final group is left `isComplete: false` so
 * the UI can keep the disclosure expanded while tokens are still streaming
 * in. Callers that have an authoritative "generation done" signal (e.g. a
 * `result` message that the decoder dropped) can force-flip the final
 * group's `isComplete` themselves.
 */
export function groupThinkingMessages(items: DisplayItem[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  let buffer: string[] = [];
  let bufferTimestamp: number | undefined;

  const flush = (isComplete: boolean) => {
    if (buffer.length === 0) return;
    const group: ThinkingGroupItem = {
      kind: "thinking-group",
      content: buffer.join(""),
      isComplete,
      ...(bufferTimestamp !== undefined ? { timestamp: bufferTimestamp } : {}),
    };
    result.push(group);
    buffer = [];
    bufferTimestamp = undefined;
  };

  for (const item of items) {
    if (
      !isToolGroup(item) &&
      !isThinkingGroup(item) &&
      isThinkingMessage(item)
    ) {
      if (buffer.length === 0) bufferTimestamp = item.timestamp;
      buffer.push(item.content);
      continue;
    }
    flush(true);
    result.push(item);
  }

  flush(false);
  return result;
}
