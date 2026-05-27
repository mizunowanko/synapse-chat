import { useState, type ReactElement } from "react";
import { cn } from "../lib/utils.js";

export interface CollapsibleOutputProps {
  content: string;
  maxLines?: number;
  label?: string;
  className?: string;
  defaultExpanded?: boolean;
}

export function CollapsibleOutput({
  content,
  maxLines = 3,
  className,
  defaultExpanded = false,
}: CollapsibleOutputProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const lines = content.split("\n");
  const needsCollapse = lines.length > maxLines;
  const displayContent = expanded || !needsCollapse
    ? content
    : lines.slice(0, maxLines).join("\n");

  return (
    <div className={cn("", className)}>
      <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/80 font-mono leading-relaxed">
        {displayContent}
      </pre>
      {needsCollapse && (
        <button
          type="button"
          className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors mt-1 cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {expanded ? "show less" : `show more (${lines.length - maxLines} more lines)`}
        </button>
      )}
    </div>
  );
}
