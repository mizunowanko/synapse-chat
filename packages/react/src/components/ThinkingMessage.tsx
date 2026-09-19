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
  /** Forwarded to {@link CollapsibleThinking}. Defaults to 300 chars. */
  autoCollapseThreshold?: number;
  className?: string;
}

/**
 * Render a {@link ThinkingGroupItem} produced by `groupThinkingMessages` as
 * a collapsible disclosure block. Auto-collapses long thinking once the
 * upstream signals that thinking has concluded; short thinking stays open.
 */
export function ThinkingMessage({
  group,
  isComplete,
  autoCollapseThreshold,
  className,
}: ThinkingMessageProps): ReactElement {
  return (
    <CollapsibleThinking
      content={group.content}
      isComplete={isComplete ?? group.isComplete}
      {...(autoCollapseThreshold !== undefined ? { autoCollapseThreshold } : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
