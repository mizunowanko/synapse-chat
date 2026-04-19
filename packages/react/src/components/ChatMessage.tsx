import {
  memo,
  useState,
  useMemo,
  useEffect,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import type { ImageAttachment, StreamMessage } from "@synapse-chat/core";
import { cn } from "../lib/utils.js";
import { formatTime } from "../lib/format-time.js";
import { remarkIssueLink } from "../lib/remark-issue-link.js";

/** Convert base64 ImageAttachments to object URLs, revoking on cleanup. */
function useImageObjectUrls(images: ImageAttachment[] | undefined): string[] {
  const urls = useMemo(() => {
    if (!images || images.length === 0) return [];
    return images.map((img) => {
      const binary = atob(img.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: img.mediaType });
      return URL.createObjectURL(blob);
    });
  }, [images]);

  useEffect(() => {
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [urls]);

  return urls;
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }: ComponentPropsWithoutRef<"a">) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/** Rendering context for alignment and styling decisions. */
export type ChatMessageContext = "command" | "ship";

export interface ChatMessageProps {
  message: StreamMessage;
  /**
   * When set, `assistant` messages are right-aligned (chat UI with the AI on
   * the right). Defaults to `"command"` (AI on the left, user on the right).
   */
  context?: ChatMessageContext;
  /**
   * `"<owner>/<repo>"` used as the default target for plain `#123` patterns.
   * When omitted, plain `#123` is left as text; `owner/repo#123` cross-repo
   * references still become links regardless.
   */
  ownerRepo?: string;
  /**
   * Custom renderer for `system` messages. Return `null` to hide a message.
   * When omitted, `system` messages render as `null` (hidden).
   */
  renderSystem?: (message: StreamMessage) => ReactNode | null;
  /**
   * Custom renderer invoked when a message carries `meta.category`. Runs
   * before the default branches, so apps can override assistant messages
   * that are tagged as logs (e.g. `meta.category === "escort-log"`). Return
   * `null` to fall through to default rendering.
   */
  renderMeta?: (message: StreamMessage) => ReactNode | null;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  context = "command",
  ownerRepo,
  renderSystem,
  renderMeta,
}: ChatMessageProps) {
  const [toolExpanded, setToolExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const imageUrls = useImageObjectUrls(message.images);

  const remarkPlugins: PluggableList = useMemo(
    () => [
      remarkGfm,
      [remarkIssueLink, ownerRepo ? { ownerRepo } : {}],
    ],
    [ownerRepo],
  );

  if (renderMeta && message.meta?.category) {
    const custom = renderMeta(message);
    if (custom !== null && custom !== undefined) return <>{custom}</>;
  }

  const isUser = message.type === "user";
  const isError = message.type === "error";
  const isSystem = message.type === "system";

  if (message.type === "tool_use") {
    const hasContent =
      Boolean(message.toolInput) ||
      (message.content && message.content !== message.tool);
    return (
      <div className="flex w-full justify-start">
        <button
          type="button"
          className={cn(
            "max-w-[90%] rounded border-l-2 border-muted-foreground/30 px-3 py-1.5 cursor-pointer select-none text-left",
            "hover:bg-muted/30 transition-colors",
          )}
          onClick={() => setToolExpanded(!toolExpanded)}
        >
          <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
            <span className="text-[10px]">{toolExpanded ? "▼" : "▶"}</span>
            <span className="text-muted-foreground/70">[{message.tool}]</span>
          </div>
          {toolExpanded && hasContent && (
            <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/80 mt-1.5 font-mono leading-relaxed">
              {message.content}
            </pre>
          )}
        </button>
      </div>
    );
  }

  if (message.type === "tool_result") {
    return (
      <div className="flex w-full justify-start">
        <button
          type="button"
          className={cn(
            "max-w-[90%] rounded border-l-2 border-emerald-500/30 px-3 py-1.5 cursor-pointer select-none text-left",
            "hover:bg-muted/30 transition-colors",
          )}
          onClick={() => setResultExpanded(!resultExpanded)}
        >
          <div className="flex items-center gap-1.5 text-xs font-mono text-emerald-400/70">
            <span className="text-[10px]">{resultExpanded ? "▼" : "▶"}</span>
            <span>result</span>
          </div>
          {resultExpanded && message.content && (
            <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/80 mt-1.5 font-mono leading-relaxed max-h-60 overflow-y-auto">
              {message.content}
            </pre>
          )}
        </button>
      </div>
    );
  }

  if (isSystem) {
    if (renderSystem) {
      const rendered = renderSystem(message);
      return rendered === null || rendered === undefined ? null : <>{rendered}</>;
    }
    return null;
  }

  if (!message.content) {
    return null;
  }

  const content = message.content;
  const isAssistantOnRight = context === "ship" && message.type === "assistant";
  const isRightAligned = isUser || isAssistantOnRight;

  return (
    <div
      className={cn(
        "flex w-full",
        isRightAligned ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
          isUser || isAssistantOnRight
            ? "bg-primary text-primary-foreground"
            : isError
              ? "bg-destructive/10 text-destructive-foreground border border-destructive/20"
              : "bg-card text-card-foreground",
        )}
      >
        {message.tool && (
          <span className="text-xs font-mono text-muted-foreground block mb-1">
            [{message.tool}]
          </span>
        )}
        {isUser && imageUrls.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mb-1.5">
            {imageUrls.map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`Attachment ${i + 1}`}
                className="h-24 max-w-48 rounded border border-primary-foreground/20 object-cover"
              />
            ))}
          </div>
        )}
        {isUser &&
          !message.images &&
          message.imageCount !== undefined &&
          message.imageCount > 0 && (
            <span className="text-xs text-primary-foreground/60 block mb-1">
              {message.imageCount} image{message.imageCount > 1 ? "s" : ""}{" "}
              attached
            </span>
          )}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{content}</p>
        ) : (
          <div className="synapse-chat-markdown break-words">
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              components={MARKDOWN_COMPONENTS}
              disallowedElements={["img"]}
              unwrapDisallowed
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
        {message.timestamp && (
          <span
            className={cn(
              "block text-[10px] mt-1 text-right",
              isRightAligned ? "text-primary-foreground/60" : "text-slate-400",
            )}
          >
            {formatTime(message.timestamp)}
          </span>
        )}
      </div>
    </div>
  );
});
