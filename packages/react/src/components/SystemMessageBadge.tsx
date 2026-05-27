import type { ReactElement, ReactNode } from "react";
import type { StreamMessage } from "@synapse-chat/core";
import { cn } from "../lib/utils.js";

export interface SystemMessageVariantConfig {
  label: string;
  icon?: string;
  colorClass?: string;
}

export interface SystemMessageBadgeProps {
  subtype: string;
  variants: Record<string, SystemMessageVariantConfig>;
  fallback?: ReactNode;
  className?: string;
  message?: StreamMessage;
}

export function SystemMessageBadge({
  subtype,
  variants,
  fallback,
  className,
  message: _message,
}: SystemMessageBadgeProps): ReactElement | null {
  const config = variants[subtype];

  if (!config) {
    return (fallback ?? null) as ReactElement | null;
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
        config.colorClass,
        className,
      )}
    >
      {config.icon && <span aria-hidden="true">{config.icon}</span>}
      <span>{config.label}</span>
    </div>
  );
}
