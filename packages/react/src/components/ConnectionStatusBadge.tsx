import type { ReactElement } from "react";
import { cn } from "../lib/utils.js";
import type { ConnectionStatus } from "../lib/ws-client.js";

export type ConnectionStatusBadgeVariant = "default" | "compact";

export interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  isRateLimited?: boolean;
  className?: string;
  variant?: ConnectionStatusBadgeVariant;
}

export function ConnectionStatusBadge({
  status,
  isRateLimited = false,
  className,
  variant = "default",
}: ConnectionStatusBadgeProps): ReactElement | null {
  if (status === "connected" && !isRateLimited) {
    return null;
  }

  const isCompact = variant === "compact";

  let dotClass: string;
  let text: string;
  let textClass: string;

  if (isRateLimited) {
    dotClass = "bg-amber-400 animate-pulse";
    text = "Rate limit — retrying...";
    textClass = "text-amber-400/80";
  } else if (status === "disconnected") {
    dotClass = "bg-red-400";
    text = "Disconnected";
    textClass = "text-red-400/80";
  } else {
    dotClass = "bg-gray-400 animate-pulse";
    text = "Reconnecting...";
    textClass = "text-gray-400/80";
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2",
        isCompact ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm",
        textClass,
        className,
      )}
    >
      <span
        className={cn(
          "inline-block rounded-full flex-shrink-0",
          isCompact ? "h-1.5 w-1.5" : "h-2 w-2",
          dotClass,
        )}
      />
      <span>{text}</span>
    </div>
  );
}
