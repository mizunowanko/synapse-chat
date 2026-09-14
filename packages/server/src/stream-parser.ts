import type { StreamMessage, TokenUsage } from "@synapse-chat/core";

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
  /** `tool_result` blocks only: the `tool_use.id` this result answers. */
  tool_use_id?: string;
  /** `tool_result` blocks only: string, or a nested block array. */
  content?: unknown;
  /** `tool_result` blocks only: the tool raised instead of returning. */
  is_error?: boolean;
}

/**
 * Flatten a `tool_result` payload to displayable text.
 *
 * The payload is a string for most tools, but an array of content blocks when
 * the tool returns mixed media (`Read` on a PNG yields a lone `image` block
 * whose `source.data` is megabytes of base64). Only `text` blocks are kept —
 * everything else is deliberately dropped rather than stringified, so a binary
 * result can never be pasted into a chat bubble.
 *
 * Returns `undefined` — not `""` — when nothing displayable survives, so
 * callers can tell "no text" apart from "the tool printed an empty string".
 */
function normalizeToolResultContent(rawContent: unknown): string | undefined {
  if (typeof rawContent === "string") {
    return rawContent.length > 0 ? rawContent : undefined;
  }
  if (Array.isArray(rawContent)) {
    const text = (rawContent as ContentBlock[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
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
 * Project a {@link ResultUsage} onto the normalized {@link TokenUsage} shape
 * carried by {@link StreamMessage}. Cache fields are omitted when zero so the
 * payload stays minimal for adapters that don't report them.
 */
export function toTokenUsage(usage: ResultUsage): TokenUsage {
  const result: TokenUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  if (usage.cacheReadInputTokens > 0) {
    result.cacheRead = usage.cacheReadInputTokens;
  }
  if (usage.cacheCreationInputTokens > 0) {
    result.cacheWrite = usage.cacheCreationInputTokens;
  }
  return result;
}

/**
 * Transform raw Claude CLI stream-json output into a StreamMessage
 * that downstream consumers can display.
 *
 * Returns null for messages that should be silently dropped (e.g. hooks, init).
 */
export interface ParseStreamMessageOptions {
  /**
   * Partial-message mode (Claude's `--include-partial-messages`).
   *
   * When the CLI streams token deltas it *also* emits the finished `assistant`
   * message for the same content, so forwarding both would render every
   * sentence twice. With this flag the finished message's `text` / `thinking`
   * blocks are dropped — the deltas already carried them — while `tool_use`
   * blocks still come from the finished message, because tool input arrives as
   * `input_json_delta` fragments that are far more fragile to reassemble than
   * to read once, whole.
   *
   * Deliberately stateless: a single adapter instance may be shared across
   * sessions, so this must not be inferred by remembering message ids.
   */
  partialMessages?: boolean;
}

export function parseStreamMessage(
  raw: Record<string, unknown>,
  options: ParseStreamMessageOptions = {},
): StreamMessage | null {
  const type = raw.type as string | undefined;
  const parsed = parseStreamMessageInner(raw, type, options);
  if (parsed) {
    parsed.timestamp =
      typeof raw.timestamp === "number" ? raw.timestamp : Date.now();
  }
  return parsed;
}

/**
 * One `stream_event` line from Claude's `--include-partial-messages` output.
 *
 * Only the two deltas that carry displayable text become messages; every
 * lifecycle event (`message_start`, `content_block_start`, `content_block_stop`,
 * `message_delta`, `message_stop`) is structural and yields `null`.
 *
 * `signature_delta` is the thinking block's cryptographic signature, not prose,
 * and `input_json_delta` is a fragment of a tool's JSON input — the finished
 * `assistant` message carries that input whole, so both are dropped here.
 */

/**
 * A stateful reader for one CLI session's stdout, layered over the pure
 * {@link parseStreamMessage}.
 *
 * #44: partial mode cannot simply drop every finished `text` / `thinking`
 * block. Locally synthesised replies — `/clear` and friends, which the CLI
 * answers itself with `model: "<synthetic>"` — never pass through the model and
 * so emit **no deltas at all**. Dropping their finished message deleted the
 * only copy, and a consumer waiting for a reply span forever.
 *
 * So the suppression is conditioned on an observed fact rather than an
 * assumption: was a delta actually seen for the message now finishing?
 *
 * `sawDelta` is reset at `message_start` and at `result`, **never when a
 * finished message is seen** — one `message_start` yields several finished
 * `assistant` lines (one per content block), and resetting on the first would
 * let the second through and double the body.
 *
 * One instance per session: the flag tracks a single stdout stream.
 */
export function createStreamMessageParser(
  options: ParseStreamMessageOptions = {},
): (raw: Record<string, unknown>) => StreamMessage | null {
  let sawDelta = false;

  return (raw) => {
    const type = raw.type as string | undefined;

    if (type === "stream_event") {
      const event = raw.event as Record<string, unknown> | undefined;
      const eventType = event?.type;
      if (eventType === "message_start") sawDelta = false;
      const parsed = parseStreamMessage(raw, options);
      if (parsed) sawDelta = true;
      return parsed;
    }

    if (type === "result") {
      const parsed = parseStreamMessage(raw, options);
      sawDelta = false;
      return parsed;
    }

    // Suppress the finished prose only when its deltas really arrived.
    return parseStreamMessage(raw, {
      ...options,
      partialMessages: options.partialMessages === true && sawDelta,
    });
  };
}

function parseStreamEvent(
  raw: Record<string, unknown>,
): StreamMessage | null {
  const event = raw.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "content_block_delta") return null;

  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta) return null;

  if (delta.type === "text_delta") {
    const text = delta.text;
    if (typeof text !== "string" || text.length === 0) return null;
    return { type: "assistant", content: text };
  }

  if (delta.type === "thinking_delta") {
    const thinking = delta.thinking;
    if (typeof thinking !== "string" || thinking.length === 0) return null;
    return { type: "assistant", subtype: "thinking", content: thinking };
  }

  return null;
}

function parseStreamMessageInner(
  raw: Record<string, unknown>,
  type: string | undefined,
  options: ParseStreamMessageOptions,
): StreamMessage | null {
  switch (type) {
    // Gated on the mode, not merely parsed when present: a parser that read
    // deltas *and* finished blocks would emit every sentence twice. Each mode
    // must be self-consistent even if fed the other mode's output.
    case "stream_event":
      return options.partialMessages ? parseStreamEvent(raw) : null;

    case "assistant": {
      const subtype = raw.subtype as string | undefined;
      if (subtype === "thinking") {
        const text =
          (raw.content as string | undefined) ??
          (raw.text as string | undefined) ??
          (raw.thinking as string | undefined);
        if (!text) return null;
        return {
          type: "assistant",
          subtype: "thinking",
          content: text,
        };
      }

      // Ollama-style chunks that emit `thinking` and `content` siblings without
      // a Claude-style content-block array. Map them to subtype:"thinking" /
      // plain assistant messages so downstream UIs can group them.
      if (typeof raw.thinking === "string" && raw.thinking.length > 0) {
        return {
          type: "assistant",
          subtype: "thinking",
          content: raw.thinking as string,
        };
      }

      const msg = raw.message as { content?: ContentBlock[] | string } | undefined;
      if (typeof msg?.content === "string" && msg.content.length > 0) {
        return {
          type: "assistant",
          content: msg.content,
        };
      }
      const blocks = (Array.isArray(msg?.content) ? msg.content : []) as ContentBlock[];

      // In partial-message mode the deltas already delivered these two block
      // kinds; re-emitting them here is what would double every sentence.
      const thinkingTexts = options.partialMessages
        ? []
        : blocks
            .filter((b) => b.type === "thinking" && b.text)
            .map((b) => b.text as string);
      if (thinkingTexts.length > 0) {
        return {
          type: "assistant",
          subtype: "thinking",
          content: thinkingTexts.join("\n"),
        };
      }

      const texts = options.partialMessages
        ? []
        : blocks
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
      const message: StreamMessage = {
        type: "result",
        content: result,
      };
      const usage = extractResultUsage(raw);
      if (usage) {
        message.usage = toTokenUsage(usage);
      }
      return message;
    }

    case "system": {
      const subtype = raw.subtype as string | undefined;
      // Drop init/hook/task-progress/thinking-token notifications — they are
      // internal CLI bookkeeping that clutters downstream chat panels.
      // `thinking_tokens` is an extended-thinking progress event Claude CLI
      // emits every ~1s; the token total is also carried by the `result`
      // message's `usage` block, so dropping the progress events does not
      // affect cost accounting.
      if (
        subtype === "init" ||
        subtype?.startsWith("hook") ||
        subtype === "task_started" ||
        subtype === "task_progress" ||
        subtype === "thinking_tokens"
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

    // Claude delivers every tool_result wrapped in a `user` turn — the API's
    // own convention, since results are fed back as user-role content:
    //
    //   {"type":"user","message":{"role":"user","content":[
    //     {"type":"tool_result","tool_use_id":"toolu_…","content":"1\thello"}]}}
    //
    // Without this case the whole turn was dropped and Claude sessions showed
    // tool calls with no results (#56). agy / Codex were unaffected: their
    // adapters build StreamMessage directly and never reach this parser.
    case "user": {
      const msg = raw.message as { content?: ContentBlock[] | string } | undefined;
      const blocks = Array.isArray(msg?.content) ? (msg.content as ContentBlock[]) : [];

      // Only tool_result blocks. A `user` turn also carries the operator's own
      // prompt (as a bare string, or as `text` blocks) — and the client already
      // appended that optimistically when it sent it (`useChat.ts`), so echoing
      // it back would draw every question twice.
      const block = blocks.find((b) => b.type === "tool_result");
      if (!block) return null;

      // First block only: `CLIAdapter.parseOutput` is one line → one message,
      // so a batch of parallel results cannot be expanded here. Same known
      // limitation as `tool_use` above, which takes `toolUses[0]`. Claude emits
      // one `user` turn per result in practice (measured, claude-haiku-4-5).
      const content = normalizeToolResultContent(block.content);
      const toolUseId = block.tool_use_id;
      if (content === undefined && !toolUseId) return null;

      // `parent_tool_use_id` (non-null inside a Task sidechain) is deliberately
      // not filtered: `case "assistant"` above already lets a subagent's
      // `tool_use` through, so dropping only its result would leave a call that
      // never visibly completes.
      return {
        type: "tool_result",
        ...(content !== undefined ? { content } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        // ToolResultMessage has no `isError` field, and the content already
        // reads as the failure ("File does not exist…"). Flagging it via `meta`
        // matches how codex.ts carries `exitCode`, and lets an app style the
        // bubble later without a core type change.
        ...(block.is_error === true ? { meta: { isError: true } } : {}),
      };
    }

    // Top-level `{"type":"tool_result"}` — the flat shape, as opposed to
    // Claude's nested one above. No bundled provider emits it today (measured:
    // Claude wraps results in `user`; agy / Codex / Gemini build StreamMessage
    // directly). It is kept because this parser is also the contract for the
    // flat "runner" dialect — `bin/ollama-runner.mjs` writes
    // `{"type":"assistant",…}` / `{"type":"result",…}` lines straight to stdout
    // — and a runner that gains tools would emit exactly this. Removing it
    // would be a silent breaking change for out-of-tree adapters.
    case "tool_result": {
      const content = normalizeToolResultContent(raw.content);
      if (content === undefined) return null;
      const toolUseId = raw.tool_use_id as string | undefined;
      return {
        type: "tool_result",
        content,
        ...(toolUseId ? { toolUseId } : {}),
      };
    }

    // Claude CLI emits rate_limit_event on stdout during rate limiting.
    // Drop these — retry logic lives at the process-manager layer.
    // `/clear`. The payload carries only ids and a timestamp — there is no text
    // to show — so this is surfaced as an open `system` variant and the app
    // decides whether it is worth drawing. Previously the CLI followed the
    // reset with a synthetic `"(no content)"` assistant message, which is what
    // consumers had been treating as the visible trace of a clear; it no longer
    // does, leaving `/clear` completely silent.
    case "conversation_reset":
      return { type: "system", subtype: "conversation-reset", content: "" };

    case "rate_limit_event":
    case "error":
      return null;

    default:
      return null;
  }
}
