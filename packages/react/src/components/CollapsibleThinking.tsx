import { useEffect, useState, type ReactElement } from "react";
import { cn } from "../lib/utils.js";

export interface CollapsibleThinkingProps {
  /** Aggregated thinking content emitted by the model. */
  content: string;
  /**
   * Whether generation has finished. While `false`, the block is expanded so
   * the user can watch the reasoning stream in. Once flipped to `true`, the
   * block auto-collapses if `content` is longer than `autoCollapseThreshold`
   * (the user can still re-expand by clicking). Shorter blocks stay open.
   */
  isComplete: boolean;
  /**
   * Completed thinking longer than this many characters auto-collapses;
   * anything at or below it stays expanded. Short thinking is usually a
   * one-line progress note the reader wants to see, while long reasoning
   * (e.g. Gemma via Ollama, thousands of chars) would push the answer off
   * screen. Defaults to {@link DEFAULT_THINKING_AUTO_COLLAPSE_THRESHOLD}.
   */
  autoCollapseThreshold?: number;
  /** Optional label shown next to the disclosure triangle. */
  label?: string;
  className?: string;
}

/** Default for {@link CollapsibleThinkingProps.autoCollapseThreshold}. */
export const DEFAULT_THINKING_AUTO_COLLAPSE_THRESHOLD = 300;

/**
 * Disclosure block for the assistant's thinking content. Mirrors the visual
 * weight of {@link CollapsibleOutput} but auto-collapses long thinking once
 * generation completes so the answer body remains the focus. Short thinking
 * stays open. A manual toggle always wins over the automatic state.
 */
export function CollapsibleThinking({
  content,
  isComplete,
  label = "Thinking",
  autoCollapseThreshold = DEFAULT_THINKING_AUTO_COLLAPSE_THRESHOLD,
  className,
}: CollapsibleThinkingProps): ReactElement {
  const autoExpanded = !isComplete || content.length <= autoCollapseThreshold;
  const [userToggled, setUserToggled] = useState(false);
  const [expanded, setExpanded] = useState(autoExpanded);

  useEffect(() => {
    if (userToggled) return;
    setExpanded(autoExpanded);
  }, [autoExpanded, userToggled]);

  const displayLabel = isComplete ? label : `${label}...`;

  return (
    <div className={cn("w-full", className)}>
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 text-xs font-mono text-muted-foreground/70",
          "hover:text-muted-foreground transition-colors cursor-pointer select-none",
        )}
        onClick={(e) => {
          e.stopPropagation();
          setUserToggled(true);
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
      >
        <span className="text-[10px]">{expanded ? "▼" : "▶"}</span>
        <span>{displayLabel}</span>
      </button>
      {expanded && content && (
        <pre
          className={cn(
            "whitespace-pre-wrap break-words text-xs text-muted-foreground/80",
            "font-mono leading-relaxed mt-1 border-l-2 border-muted-foreground/20 pl-2",
          )}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
