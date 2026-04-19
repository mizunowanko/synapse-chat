import type { StreamMessage } from "@synapse-chat/core";

export interface MessageFilterRule<TContext extends string = string> {
  /** `system` message `subtype` this rule matches. */
  subtype: string;
  /** Contexts in which a matching message is rendered. */
  contexts: readonly TContext[];
}

export interface CreateMessageFilterOptions<TContext extends string = string> {
  /** Declarative rules for rendering `system` messages by `subtype`. */
  rules: readonly MessageFilterRule<TContext>[];
  /** Contexts in which `user` messages are hidden entirely (e.g. ship log). */
  hideUserInContexts?: readonly TContext[];
  /**
   * Visibility of messages carrying `meta.category`, keyed by the category
   * value. Useful when the category is emitted for non-`system` types (e.g.
   * an assistant message tagged as "escort-log").
   */
  metaCategoryContexts?: Readonly<Record<string, readonly TContext[]>>;
  /**
   * When a `system` message has an unknown `subtype` and no `meta.category`,
   * drop it. Defaults to `true` (matches original vibe-admiral behaviour
   * where unknown subtypes render as `null`).
   */
  dropUnknownSystem?: boolean;
}

/**
 * Build a pre-filter that removes messages a chat renderer would otherwise
 * suppress (return null for). Removing them before `groupToolMessages()`
 * prevents invisible messages from breaking consecutive tool_use grouping.
 *
 * The default behaviour is purely generic: it has no knowledge of any
 * specific `subtype` values. Apps declare the set of render-able subtypes
 * via `options.rules`.
 */
export function createMessageFilter<TContext extends string = string>(
  options: CreateMessageFilterOptions<TContext>,
): (msgs: readonly StreamMessage[], context: TContext) => StreamMessage[] {
  const ruleMap = new Map(options.rules.map((r) => [r.subtype, r] as const));
  const hideUser = new Set<TContext>(options.hideUserInContexts ?? []);
  const metaCategories = options.metaCategoryContexts ?? {};
  const dropUnknownSystem = options.dropUnknownSystem ?? true;

  return (msgs, context) => {
    const hideUserHere = hideUser.has(context);
    const result: StreamMessage[] = [];
    for (const msg of msgs) {
      if (!msg) continue;

      if (hideUserHere && msg.type === "user") continue;

      const category =
        typeof msg.meta?.category === "string" ? msg.meta.category : undefined;
      if (category && metaCategories[category]) {
        if (!metaCategories[category].includes(context)) continue;
      }

      if (msg.type === "system") {
        const rule = msg.subtype ? ruleMap.get(msg.subtype) : undefined;
        if (rule) {
          if (!rule.contexts.includes(context)) continue;
        } else if (category) {
          // Fall through — category-based messages are already resolved above.
        } else if (dropUnknownSystem) {
          continue;
        }
      } else if (!msg.content && msg.type !== "tool_use") {
        continue;
      }

      result.push(msg);
    }
    return result;
  };
}
