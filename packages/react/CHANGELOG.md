# @mizunowanko/synapse-chat-react

## 0.3.0

## 0.2.0

## 0.1.0

### Minor Changes

- acba9f1: Add `CollapsibleOutput` component for truncating long text output with show-more / show-less toggle. Add `maxOutputLines` prop to `ToolUseGroup` and `ChatMessage` for opt-in collapsible tool result content.
- 7336708: feat(react): add CompactionBadge component and auto-render on compaction system messages

  - New `CompactionBadge` component exported from `@synapse-chat/react` with animate-pulse violet styling
  - `ChatMessage` now auto-renders `CompactionBadge` when `message.subtype` is `"compact-status"` or `"compacting"`
  - Existing `renderSystem` prop continues to override the default behavior

- 83b489a: Add `ConnectionStatusBadge` component for displaying connection and rate-limit state
- 6440508: feat(react): expose underlying `WSClient` from `useChat`

  `useChat` now returns a `client` field — the same `WSClient` instance the hook uses internally. Use it to send arbitrary control messages (e.g. `{ type: "app:reset" }`) without spinning up a second `useWebSocket`, which would open a duplicate socket from the same component.

  ```tsx
  const { sendMessage, messages, client } = useChat({ wsOptions: { url } });
  const reset = () => client.send({ type: "app:reset" });
  ```

  The `UseChatResult` type is now generic over `<TServer, TClient>` to type the exposed `client`. Existing call sites that don't reference `client` are unaffected.

- 901efff: `CollapsibleThinking` / `ThinkingMessage` no longer auto-collapse short thinking once generation completes. Thinking at or below `autoCollapseThreshold` characters (default 300, exported as `DEFAULT_THINKING_AUTO_COLLAPSE_THRESHOLD`) stays expanded so one-line progress notes remain readable; longer thinking (e.g. Gemma via Ollama) still collapses as before. A manual toggle still overrides the automatic state.
- 7057736: First release, published to GitHub Packages (#68)

  The packages are published as `@mizunowanko/synapse-chat-{core,react,server,mcp}`
  because GitHub Packages requires the npm scope to match the repository owner.
  Import paths do not change: consumers install them under the old names through an
  npm alias, e.g. `"@synapse-chat/core": "npm:@mizunowanko/synapse-chat-core@0.1.0"`.
  All four packages share one version.

- 1b812b1: feat(react): connection-status hook + optimistic message queue with reconnect-backed retry

  The React hooks now surface fine-grained connection lifecycle and protect in-flight sends from network drops.

  **WSClient / useWebSocket / useConnectionStatus**

  - `WSClient` exposes a `status` getter and `onStatusChange` subscription with three phases: `"disconnected"` | `"reconnecting"` | `"connected"`. The first connect attempt and any subsequent reconnect both surface as `"reconnecting"` so consumers can render a single "trying…" indicator.
  - `useWebSocket` returns `connectionStatus` alongside the existing `isConnected` flag, and replaces the 1-second polling fallback with a direct subscription.
  - New `useConnectionStatus(client)` hook for consumers that want connection state without re-binding the full chat hook.
  - `WSClient.send` now returns `boolean` (`false` when the socket is not open) so callers can detect dropped writes.

  **useChat optimistic queue**

  - `sendMessage()` updates local state synchronously with a `pending` user message and queues the payload. On the next `connected` transition the queue flushes in FIFO order; each reconnect counts as one retry.
  - New options: `maxRetries` (default `3`), `onSendError(message, reason)`, and `ackPredicate(raw)` for protocols that confirm delivery server-side. Without `ackPredicate` the local echo is treated as canonical; with it, the placeholder is dropped on ack to avoid duplication.
  - New return fields: `connectionStatus`, `pendingMessageIds`. `sendMessage` now returns the generated `clientMessageId`. The default `encode` includes `clientMessageId` on the wire payload so apps that want server-side ack can use it.
  - Optimistic messages carry `meta.clientMessageId` and `meta.optimisticStatus` (`"pending" | "sent"`); rolled-back messages are removed from the list and `onSendError` fires with `"max-retries-exceeded"`.

  **Bug fix**

  - `WSClient.disconnect()` no longer re-enters `scheduleReconnect()` via the synchronous `onclose` dispatch — handlers are detached before `close()` is called.

  All changes are additive; existing `useChat` / `useWebSocket` call sites continue to work unchanged.

- e599217: Add default Markdown CSS styles via `@synapse-chat/react/styles` subpath export.

  Consumers can opt in by importing:

  ```typescript
  import "@synapse-chat/react/styles";
  ```

  The stylesheet styles `.synapse-chat-markdown` elements (tables, code blocks, blockquotes, lists, headings) and exposes CSS custom properties for theming:

  - `--synapse-chat-border` (default: `#e2e8f0`)
  - `--synapse-chat-code-bg` (default: `#f8fafc`)
  - `--synapse-chat-muted` (default: `#64748b`)

- 13cddfa: `SessionInput` に `actions` と `minRows` を追加。

  - `actions?: ReactNode` — 送信ボタンの真上に縦に積むボタン。渡すと右の列が 24px × 2 段になり（送信ボタンは 36px → 24px）、2 行ぶんの入力欄とちょうど同じ高さになる。
  - `minRows?: number` — 空のときの入力欄の行数（既定 1）。自動で伸びる上限は 6 行（`minRows` がそれより大きければ `minRows`）。

  どちらも省略すれば、見た目は今までと同じ。

  ```tsx
  <SessionInput
    value={draft}
    onChange={setDraft}
    onSend={send}
    minRows={2}
    actions={<TemplateButton />}
  />
  ```

- 1a5fade: feat: add Chat Storage Adapter pattern for history persistence

  - `@synapse-chat/core` exports a new `ChatStorage<T>` interface (`save` / `load` / `clear`).
  - `@synapse-chat/react/storage` ships two opt-in adapters: `createLocalStorageAdapter` and `createIndexedDBAdapter`. Both are SSR-safe (no-op when the underlying browser API is missing).
  - `useChat` accepts `storage` + `sessionId` options, hydrates on mount, debounces writes, and exposes `isHydrating`. Without those options the hook behaves exactly as before.

- 4275474: Add `SystemMessageBadge` component for rendering system message subtypes as styled badges.

  Consumers pass a `variants` map of `subtype → { label, icon?, colorClass? }` and the component renders the matching badge, or a `fallback` node when the subtype is not found. An optional `message` prop provides access to the full `StreamMessage` for metadata.

  ```tsx
  <SystemMessageBadge
    subtype={message.subtype ?? ""}
    variants={{
      "gate-check-request": {
        label: "Gate Check",
        icon: "🔍",
        colorClass: "bg-indigo-100 text-indigo-800",
      },
      "lookout-alert": {
        label: "Alert",
        icon: "🚨",
        colorClass: "bg-red-100 text-red-800",
      },
    }}
    message={message}
  />
  ```
