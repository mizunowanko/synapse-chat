import type { ReactElement } from "react";
import { cn } from "../lib/utils.js";

export interface CompactionBadgeProps {
  className?: string;
}

export function CompactionBadge({ className }: CompactionBadgeProps): ReactElement {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm text-violet-400/80",
        className,
      )}
    >
      <span className="inline-block h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
      <span>Compacting context…</span>
    </div>
  );
}
