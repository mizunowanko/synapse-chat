import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  ChatStorage,
  ImageAttachment,
  StreamMessage,
} from "@synapse-chat/core";
import type {
  ConnectionStatus,
  WSClient,
  WSClientOptions,
} from "../lib/ws-client.js";
import { useWebSocket } from "./useWebSocket.js";

/** Lifecycle of an optimistic user message. */
export type OptimisticMessageStatus = "pending" | "sent" | "failed";

export interface UseChatOptions<TServer = unknown, TClient = unknown> {
  /** Options passed through to the underlying {@link WSClient}. */
  wsOptions: WSClientOptions<TServer, TClient>;
  /**
   * Convert an incoming server payload into zero or more StreamMessages.
   * Returning `null` (or an empty array) ignores the payload. Required
   * because only the app knows its own message protocol.
   */
  decode: (raw: TServer) => StreamMessage | StreamMessage[] | null;
  /**
   * Build the client message sent when the user submits text + images. The
   * default emits `{ type: "chat", content, images }`; replace it when your
   * server expects a different shape.
   *
   * Receives the locally-generated `clientMessageId` so apps that want
   * server-side ack tracking can include it in their wire format.
   */
  encode?: (
    text: string,
    images: ImageAttachment[] | undefined,
    clientMessageId: string,
  ) => TClient;
  /**
   * Inspect an incoming server payload and, if it acknowledges a previously
   * sent optimistic message, return the matching `clientMessageId`. Return
   * `null` when the payload is not an ack.
   *
   * When omitted, optimistic messages are confirmed as soon as the WebSocket
   * accepts the payload (no server-side round trip required).
   */
  ackPredicate?: (raw: TServer) => string | null;
  /**
   * Seed the chat (e.g. from server-rendered history). Ignored once storage
   * hydration resolves with a non-null payload.
   */
  initialMessages?: readonly StreamMessage[];
  /**
   * Optional {@link ChatStorage} adapter. When supplied together with
   * `sessionId`, the hook hydrates from storage on mount and writes back on
   * every message change.
   */
  storage?: ChatStorage<StreamMessage>;
  /** Identifies the chat session in the storage backend. */
  sessionId?: string;
  /**
   * Milliseconds to coalesce writes. Defaults to `200`. Set to `0` to write
   * on every change (useful in tests; rarely what you want in production).
   */
  saveDebounceMs?: number;
  /**
   * Maximum number of times an unsent message will be retried after the
   * socket reconnects. Once exceeded, the message is rolled out of local
   * state and `onSendError` (if set) fires. Defaults to `3`.
   */
  maxRetries?: number;
  /**
   * Called when an optimistic message is rolled back after exhausting all
   * retries. Receives the rolled-back message so the consumer can show a
   * toast or surface a retry button.
   */
  onSendError?: (message: StreamMessage, reason: "max-retries-exceeded") => void;
}

export interface UseChatResult<TServer = unknown, TClient = unknown> {
  /** Messages in display order. Includes optimistic (pending/failed) entries. */
  messages: StreamMessage[];
  /** Replace the message list wholesale (e.g. to load history). */
  setMessages: Dispatch<SetStateAction<StreamMessage[]>>;
  /** Append a single message locally (e.g. optimistic user echo). */
  appendMessage: (msg: StreamMessage) => void;
  /** Clear all messages, and clear storage if configured. */
  clear: () => void;
  /**
   * Send a user message. Local state is updated immediately with a `pending`
   * entry; if the socket is offline the entry stays queued and is retried on
   * the next reconnect. Returns the generated `clientMessageId`.
   */
  sendMessage: (text: string, images?: ImageAttachment[]) => string;
  /** `true` while the socket is open. */
  isConnected: boolean;
  /** Fine-grained socket lifecycle phase. */
  connectionStatus: ConnectionStatus;
  /**
   * `true` while the first `storage.load(sessionId)` is in flight. Always
   * `false` when no storage/sessionId is configured.
   */
  isHydrating: boolean;
  /**
   * IDs of messages that have been added locally but not yet acknowledged.
   * Empty when nothing is in flight.
   */
  pendingMessageIds: string[];
  /**
   * The underlying {@link WSClient}. Stable across renders. Use this to send
   * arbitrary client messages (e.g. control frames like `{ type: "app:reset" }`)
   * without spinning up a second `useWebSocket` — which would open a second
   * socket, since each `useWebSocket` instantiates its own client.
   */
  client: WSClient<TServer, TClient>;
}

function defaultEncode<TClient>(
  text: string,
  images: ImageAttachment[] | undefined,
  clientMessageId: string,
): TClient {
  const payload: Record<string, unknown> = {
    type: "chat",
    content: text,
    clientMessageId,
  };
  if (images && images.length > 0) payload.images = images;
  return payload as TClient;
}

function generateClientMessageId(): string {
  const cryptoApi: { randomUUID?: () => string } | undefined = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // Fallback for environments without crypto.randomUUID (older test runners).
  // Collision risk is acceptable for short-lived UI ids.
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface PendingEntry<TClient> {
  encoded: TClient;
  attempts: number;
  message: StreamMessage;
}

/**
 * High-level chat hook. Combines a WebSocket connection, a decoder for
 * incoming messages, an optimistic send helper with reconnect-backed retry,
 * and (optionally) a pluggable persistence layer via {@link ChatStorage}.
 *
 * Optimistic semantics:
 * - `sendMessage()` returns immediately; a `StreamMessage` with
 *   `meta.clientMessageId` and `meta.optimisticStatus = "pending"` is appended
 *   to local state synchronously.
 * - If the socket is open, the payload is written immediately. Without
 *   `ackPredicate`, the entry transitions to `"sent"` (pending list shrinks)
 *   right away. With `ackPredicate`, it stays `"pending"` until a matching
 *   server message arrives.
 * - If the socket is offline, the entry stays in the pending queue. On the
 *   next `connected` transition the queue is flushed in FIFO order. Each
 *   reconnect counts as one retry — after `maxRetries`, the entry is removed
 *   from local state and `onSendError` fires.
 *
 * Persistence semantics (when `storage` + `sessionId` are both provided):
 * - On mount and whenever `sessionId` changes, the hook calls
 *   `storage.load(sessionId)`. `isHydrating` is `true` until that resolves.
 * - If the load returns a non-null array, it replaces the in-memory messages.
 *   If it returns `null`, `initialMessages` is used as a fallback.
 * - After hydration completes, any change to `messages` is written back via
 *   `storage.save(sessionId, messages)`, debounced by `saveDebounceMs`.
 * - Writes that complete after the component unmounts or after `sessionId`
 *   changes are ignored by the consumer; in-flight saves from the previous
 *   session still run to completion so data isn't lost.
 * - `clear()` removes in-memory messages AND calls `storage.clear(sessionId)`.
 */
export function useChat<TServer = unknown, TClient = unknown>(
  options: UseChatOptions<TServer, TClient>,
): UseChatResult<TServer, TClient> {
  const {
    wsOptions,
    decode,
    encode,
    ackPredicate,
    initialMessages,
    storage,
    sessionId,
    saveDebounceMs = 200,
    maxRetries = 3,
    onSendError,
  } = options;
  const encoder = encode ?? defaultEncode<TClient>;

  const { client, isConnected, connectionStatus, send } = useWebSocket<
    TServer,
    TClient
  >(wsOptions);

  const persistenceEnabled = Boolean(storage && sessionId);
  const [messages, setMessages] = useState<StreamMessage[]>(() =>
    initialMessages ? [...initialMessages] : [],
  );
  const [isHydrating, setIsHydrating] = useState<boolean>(persistenceEnabled);
  const [pendingMessageIds, setPendingMessageIds] = useState<string[]>([]);

  // Tracks whether the first storage load has resolved. Until then, messages
  // changes must not be persisted — the initial empty state would overwrite
  // whatever is on disk before we've had a chance to load it.
  const hydratedRef = useRef<boolean>(!persistenceEnabled);

  // Pending queue for optimistic sends. Refs (not state) because only the
  // flushQueue/sendMessage paths mutate it, and we don't want extra renders
  // when the queue contents change — the user-visible projection lives in
  // `pendingMessageIds`/`messages`.
  const queueRef = useRef<Map<string, PendingEntry<TClient>>>(new Map());
  // Latest copies of consumer callbacks/options. Captured so the long-lived
  // status subscription doesn't have to re-bind on every render.
  const ackPredicateRef = useRef(ackPredicate);
  const onSendErrorRef = useRef(onSendError);
  const maxRetriesRef = useRef(maxRetries);
  ackPredicateRef.current = ackPredicate;
  onSendErrorRef.current = onSendError;
  maxRetriesRef.current = maxRetries;

  // ── Optimistic helpers ──────────────────────────────────────────────────

  const updateOptimisticStatus = useCallback(
    (clientMessageId: string, nextStatus: OptimisticMessageStatus) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.meta?.clientMessageId === clientMessageId
            ? { ...m, meta: { ...m.meta, optimisticStatus: nextStatus } }
            : m,
        ),
      );
    },
    [],
  );

  const removePendingId = useCallback((clientMessageId: string) => {
    setPendingMessageIds((prev) =>
      prev.includes(clientMessageId)
        ? prev.filter((id) => id !== clientMessageId)
        : prev,
    );
  }, []);

  const markSent = useCallback(
    (clientMessageId: string) => {
      queueRef.current.delete(clientMessageId);
      removePendingId(clientMessageId);
      // Without ackPredicate we treat the local echo as the canonical
      // message, so just strip the "pending" marker. With ackPredicate the
      // server will deliver its own copy and the optimistic entry is
      // removed by `applyAck` instead.
      if (!ackPredicateRef.current) {
        updateOptimisticStatus(clientMessageId, "sent");
      }
    },
    [removePendingId, updateOptimisticStatus],
  );

  const applyAck = useCallback(
    (clientMessageId: string) => {
      queueRef.current.delete(clientMessageId);
      removePendingId(clientMessageId);
      // The server's own message will be appended via the normal onMessage
      // path; drop the optimistic placeholder to avoid duplication.
      setMessages((prev) =>
        prev.filter((m) => m.meta?.clientMessageId !== clientMessageId),
      );
    },
    [removePendingId],
  );

  const rollback = useCallback(
    (clientMessageId: string) => {
      const entry = queueRef.current.get(clientMessageId);
      queueRef.current.delete(clientMessageId);
      removePendingId(clientMessageId);
      setMessages((prev) =>
        prev.filter((m) => m.meta?.clientMessageId !== clientMessageId),
      );
      if (entry && onSendErrorRef.current) {
        onSendErrorRef.current(entry.message, "max-retries-exceeded");
      }
    },
    [removePendingId],
  );

  const trySend = useCallback(
    (clientMessageId: string) => {
      const entry = queueRef.current.get(clientMessageId);
      if (!entry) return;
      const ok = send(entry.encoded);
      if (!ok) {
        // Send dropped — the socket is closed. Don't count this as a "retry"
        // attempt: the user hasn't had a reconnect cycle to recover yet.
        // Retry counting happens in flushQueue (post-reconnect).
        return;
      }
      // With ackPredicate, the entry stays queued until the server confirms;
      // without it, the local echo is the canonical message.
      if (!ackPredicateRef.current) {
        markSent(clientMessageId);
      }
    },
    [send, markSent],
  );

  // ── Storage hydration / persistence (unchanged from before) ─────────────

  useEffect(() => {
    if (!storage || !sessionId) {
      hydratedRef.current = true;
      setIsHydrating(false);
      return;
    }
    let cancelled = false;
    hydratedRef.current = false;
    setIsHydrating(true);
    storage
      .load(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded !== null) {
          setMessages([...loaded]);
        }
        hydratedRef.current = true;
        setIsHydrating(false);
      })
      .catch(() => {
        if (cancelled) return;
        hydratedRef.current = true;
        setIsHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storage, sessionId]);

  useEffect(() => {
    if (!storage || !sessionId) return;
    if (!hydratedRef.current) return;
    const handle = setTimeout(() => {
      void storage.save(sessionId, messages);
    }, saveDebounceMs);
    return () => clearTimeout(handle);
  }, [messages, storage, sessionId, saveDebounceMs]);

  // ── Inbound message handling ────────────────────────────────────────────

  useEffect(() => {
    const unsub = client.onMessage((raw) => {
      const ackId = ackPredicateRef.current?.(raw) ?? null;
      if (ackId !== null && queueRef.current.has(ackId)) {
        applyAck(ackId);
        // Fall through: the ack payload may also carry renderable content
        // (e.g. an assistant reply), so let the decoder see it.
      }
      const decoded = decode(raw);
      if (decoded === null) return;
      const batch = Array.isArray(decoded) ? decoded : [decoded];
      if (batch.length === 0) return;
      setMessages((prev) => [...prev, ...batch]);
    });
    return unsub;
  }, [client, decode, applyAck]);

  // ── Reconnect-driven flush ──────────────────────────────────────────────

  useEffect(() => {
    // Flush whenever we (re)enter the connected state. Each pass through
    // the loop counts as one retry attempt — after `maxRetries` cycles
    // without success, the message is rolled back.
    const unsub = client.onStatusChange((next) => {
      if (next !== "connected") return;
      const ids = Array.from(queueRef.current.keys());
      for (const id of ids) {
        const entry = queueRef.current.get(id);
        if (!entry) continue;
        entry.attempts += 1;
        const ok = send(entry.encoded);
        if (ok) {
          if (!ackPredicateRef.current) {
            markSent(id);
          }
          // ackPredicate set: stay queued, wait for the server confirmation.
          // Each reconnect still bumps `attempts`, so a perpetually-silent
          // server eventually trips maxRetries and rolls back.
        } else if (entry.attempts >= maxRetriesRef.current) {
          rollback(id);
        }
      }
    });
    return unsub;
  }, [client, send, markSent, rollback]);

  // ── Public API ──────────────────────────────────────────────────────────

  const appendMessage = useCallback((msg: StreamMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setPendingMessageIds([]);
    queueRef.current.clear();
    if (storage && sessionId) {
      void storage.clear(sessionId);
    }
  }, [storage, sessionId]);

  const sendMessage = useCallback(
    (text: string, images?: ImageAttachment[]): string => {
      const clientMessageId = generateClientMessageId();
      const encoded = encoder(text, images, clientMessageId);
      const optimistic: StreamMessage = {
        type: "user",
        content: text,
        ...(images && images.length > 0 ? { images } : {}),
        meta: {
          clientMessageId,
          optimisticStatus: "pending" satisfies OptimisticMessageStatus,
        },
      };
      queueRef.current.set(clientMessageId, {
        encoded,
        attempts: 0,
        message: optimistic,
      });
      setMessages((prev) => [...prev, optimistic]);
      setPendingMessageIds((prev) => [...prev, clientMessageId]);
      trySend(clientMessageId);
      return clientMessageId;
    },
    [encoder, trySend],
  );

  return {
    messages,
    setMessages,
    appendMessage,
    clear,
    sendMessage,
    isConnected,
    connectionStatus,
    isHydrating,
    pendingMessageIds,
    client,
  };
}
