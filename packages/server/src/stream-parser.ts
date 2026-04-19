import type { StreamMessage } from "@synapse-chat/core";

/**
 * Token usage and cost extracted from a Claude CLI session `result` message.
 *
 * Claude CLI emits a `result` stream-json event at session end containing
 * `total_cost_usd` and a `usage` block with token counts. This shape flattens
 * those fields for consumers.
 */
export interface ResultUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Extract sessionId from a raw init message.
 * Returns the sessionId string if this is an init message, null otherwise.
 * Must be called BEFORE parseStreamMessage (which drops init messages).
 */
export function extractSessionId(
  raw: Record<string, unknown>,
): string | null {
  if (raw.type !== "system") return null;
  if (raw.subtype !== "init") return null;
  const sessionId = raw.session_id as string | undefined;
  return sessionId ?? null;
}

/**
 * Extract token usage and cost from a raw result message.
 * Claude CLI emits a `result` message at session end that may contain
 * `cost_usd` (session total) and `usage` (input/output token counts).
 * Returns null if the message is not a result or lacks usage data.
 */
export function extractResultUsage(
  raw: Record<string, unknown>,
): ResultUsage | null {
  if (raw.type !== "result") return null;

  const costUsd = raw.total_cost_usd as number | undefined;
  const usage = raw.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;

  // Require at least cost or usage to be present
  if (costUsd === undefined && !usage) return null;

  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    costUsd: costUsd ?? 0,
  };
}

/**
 * Transform raw Claude CLI stream-json output into a StreamMessage
 * that downstream consumers can display.
 *
 * Returns null for messages that should be silently dropped (e.g. hooks, init).
 */
export function parseStreamMessage(
  raw: Record<string, unknown>,
): StreamMessage | null {
  const type = raw.type as string | undefined;
  const parsed = parseStreamMessageInner(raw, type);
  if (parsed) {
    parsed.timestamp =
      typeof raw.timestamp === "number" ? raw.timestamp : Date.now();
  }
  return parsed;
}

function parseStreamMessageInner(
  raw: Record<string, unknown>,
  type: string | undefined,
): StreamMessage | null {
  switch (type) {
    case "assistant": {
      const msg = raw.message as { content?: ContentBlock[] } | undefined;
      const blocks = msg?.content ?? [];

      const texts = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string);

      const toolUses = blocks.filter((b) => b.type === "tool_use");

      if (texts.length > 0) {
        return {
          type: "assistant",
          content: texts.join("\n"),
        };
      }

      if (toolUses.length > 0) {
        const toolName = toolUses[0]?.name ?? "tool";
        const toolInput = toolUses[0]?.input;
        const toolUseId = toolUses[0]?.id;
        return {
          type: "tool_use",
          tool: toolName,
          content: toolInput ? JSON.stringify(toolInput, null, 2) : toolName,
          ...(toolInput ? { toolInput } : {}),
          ...(toolUseId ? { toolUseId } : {}),
        };
      }

      return null;
    }

    case "result": {
      const result = raw.result as string | undefined;
      if (!result) return null;
      return {
        type: "result",
        content: result,
      };
    }

    case "system": {
      const subtype = raw.subtype as string | undefined;
      // Drop init/hook/task-progress notifications — they are internal CLI
      // bookkeeping that clutters downstream chat panels.
      if (
        subtype === "init" ||
        subtype?.startsWith("hook") ||
        subtype === "task_started" ||
        subtype === "task_progress"
      ) {
        return null;
      }
      if (subtype === "task_notification") {
        const chat = raw.chat as
          | Array<{ role?: string; content?: string }>
          | undefined;
        if (Array.isArray(chat) && chat.length > 0) {
          const lastAssistant = [...chat]
            .reverse()
            .find((m) => m.role === "assistant" && m.content);
          if (lastAssistant?.content) {
            return {
              type: "system",
              subtype: "dispatch-log",
              content: lastAssistant.content,
            };
          }
        }
        const desc =
          (raw.description as string | undefined) ??
          (raw.content as string | undefined);
        if (!desc) {
          // Emit an empty dispatch-log so consumers can detect completion even
          // without chat or description content.
          return {
            type: "system",
            subtype: "dispatch-log",
            content: "",
          };
        }
        return {
          type: "system",
          subtype: "task-notification",
          content: desc,
        };
      }
      if (subtype === "status") {
        const status = raw.status as string | null | undefined;
        if (status === "compacting" || status === null || status === undefined) {
          return {
            type: "system",
            subtype: "compact-status",
            content:
              status === "compacting"
                ? "Compacting context..."
                : "Context compaction complete",
          };
        }
        // Non-compact status messages fall through to the generic handler.
      }
      if (subtype === "compact_boundary") {
        const metadata = raw.compact_metadata as
          | { trigger?: string; pre_tokens?: number }
          | undefined;
        const trigger = metadata?.trigger ?? "auto";
        const preTokens = metadata?.pre_tokens;
        const detail = preTokens
          ? `Context compacted (${trigger}, ${preTokens.toLocaleString()} tokens before)`
          : `Context compacted (${trigger})`;
        return {
          type: "system",
          subtype: "compact-status",
          content: detail,
        };
      }
      return {
        type: "system",
        ...(subtype !== undefined ? { subtype } : {}),
        content: (raw.content as string) ?? subtype ?? "system",
      };
    }

    case "tool_result": {
      const rawContent = raw.content;
      let content: string | undefined;
      if (typeof rawContent === "string") {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        content = (rawContent as ContentBlock[])
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text as string)
          .join("\n");
      }
      if (!content) return null;
      const toolUseId = raw.tool_use_id as string | undefined;
      return {
        type: "tool_result",
        content,
        ...(toolUseId ? { toolUseId } : {}),
      };
    }

    // Claude CLI emits rate_limit_event on stdout during rate limiting.
    // Drop these — retry logic lives at the process-manager layer.
    case "rate_limit_event":
    case "error":
      return null;

    default:
      return null;
  }
}
