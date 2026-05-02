---
"@synapse-chat/react": minor
---

feat(react): connection-status hook + optimistic message queue with reconnect-backed retry

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
