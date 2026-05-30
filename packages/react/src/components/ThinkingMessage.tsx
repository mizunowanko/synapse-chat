import type { ReactElement } from "react";
import type { ThinkingGroupItem } from "../lib/group-tool-messages.js";
import { CollapsibleThinking } from "./CollapsibleThinking.js";

export interface ThinkingMessageProps {
  group: ThinkingGroupItem;
  /**
   * Override the group's own `isComplete`. Useful when the app has a
   * separate "generation finished" signal (e.g. the WebSocket emitted a
   * `result` event the decoder dropped).
   */
  isComplete?: boolean;
  className?: string;
}

/**
 * Render a {@link ThinkingGroupItem} produced by `groupThinkingMessages` as
 * a collapsible disclosure block. Auto-collapses once the upstream signals
 * that thinking has concluded.
 */
export function ThinkingMessage({
  group,
  isComplete,
  className,
}: ThinkingMessageProps): ReactElement {
  return (
    <CollapsibleThinking
      content={group.content}
      isComplete={isComplete ?? group.isComplete}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
