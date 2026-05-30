import { useEffect, useState, type ReactElement } from "react";
import { cn } from "../lib/utils.js";

export interface CollapsibleThinkingProps {
  /** Aggregated thinking content emitted by the model. */
  content: string;
  /**
   * Whether generation has finished. While `false`, the block is expanded so
   * the user can watch the reasoning stream in. Once flipped to `true`, the
   * block auto-collapses (the user can still re-expand by clicking).
   */
  isComplete: boolean;
  /** Optional label shown next to the disclosure triangle. */
  label?: string;
  className?: string;
}

/**
 * Disclosure block for the assistant's thinking content. Mirrors the visual
 * weight of {@link CollapsibleOutput} but auto-collapses once generation
 * completes so the answer body remains the focus.
 */
export function CollapsibleThinking({
  content,
  isComplete,
  label = "Thinking",
  className,
}: CollapsibleThinkingProps): ReactElement {
  const [userToggled, setUserToggled] = useState(false);
  const [expanded, setExpanded] = useState(!isComplete);

  useEffect(() => {
    if (userToggled) return;
    setExpanded(!isComplete);
  }, [isComplete, userToggled]);

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
