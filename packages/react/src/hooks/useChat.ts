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
import type { WSClientOptions } from "../lib/ws-client.js";
import { useWebSocket } from "./useWebSocket.js";

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
   */
  encode?: (text: string, images?: ImageAttachment[]) => TClient;
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
}

export interface UseChatResult {
  /** Messages in display order. */
  messages: StreamMessage[];
  /** Replace the message list wholesale (e.g. to load history). */
  setMessages: Dispatch<SetStateAction<StreamMessage[]>>;
  /** Append a single message locally (e.g. optimistic user echo). */
  appendMessage: (msg: StreamMessage) => void;
  /** Clear all messages, and clear storage if configured. */
  clear: () => void;
  /** Send a user message through the socket. */
  sendMessage: (text: string, images?: ImageAttachment[]) => void;
  /** `true` while the socket is open. */
  isConnected: boolean;
  /**
   * `true` while the first `storage.load(sessionId)` is in flight. Always
   * `false` when no storage/sessionId is configured.
   */
  isHydrating: boolean;
}

function defaultEncode<TClient>(text: string, images?: ImageAttachment[]): TClient {
  const payload: Record<string, unknown> = { type: "chat", content: text };
  if (images && images.length > 0) payload.images = images;
  return payload as TClient;
}

/**
 * High-level chat hook. Combines a WebSocket connection, a decoder for
 * incoming messages, a send helper, and (optionally) a pluggable persistence
 * layer via {@link ChatStorage}.
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
): UseChatResult {
  const {
    wsOptions,
    decode,
    encode,
    initialMessages,
    storage,
    sessionId,
    saveDebounceMs = 200,
  } = options;
  const encoder = encode ?? defaultEncode<TClient>;

  const { client, isConnected, send } = useWebSocket<TServer, TClient>(wsOptions);

  const persistenceEnabled = Boolean(storage && sessionId);
  const [messages, setMessages] = useState<StreamMessage[]>(() =>
    initialMessages ? [...initialMessages] : [],
  );
  const [isHydrating, setIsHydrating] = useState<boolean>(persistenceEnabled);

  // Tracks whether the first storage load has resolved. Until then, messages
  // changes must not be persisted — the initial empty state would overwrite
  // whatever is on disk before we've had a chance to load it.
  const hydratedRef = useRef<boolean>(!persistenceEnabled);

  // Hydration effect. Re-runs when the session or adapter changes.
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

  // Save effect. Debounced. Skipped until hydration completes so we never
  // clobber persisted data with the empty initial state.
  useEffect(() => {
    if (!storage || !sessionId) return;
    if (!hydratedRef.current) return;
    const handle = setTimeout(() => {
      void storage.save(sessionId, messages);
    }, saveDebounceMs);
    return () => clearTimeout(handle);
  }, [messages, storage, sessionId, saveDebounceMs]);

  useEffect(() => {
    const unsub = client.onMessage((raw) => {
      const decoded = decode(raw);
      if (decoded === null) return;
      const batch = Array.isArray(decoded) ? decoded : [decoded];
      if (batch.length === 0) return;
      setMessages((prev) => [...prev, ...batch]);
    });
    return unsub;
  }, [client, decode]);

  const appendMessage = useCallback((msg: StreamMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    if (storage && sessionId) {
      void storage.clear(sessionId);
    }
  }, [storage, sessionId]);

  const sendMessage = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      send(encoder(text, images));
    },
    [send, encoder],
  );

  return {
    messages,
    setMessages,
    appendMessage,
    clear,
    sendMessage,
    isConnected,
    isHydrating,
  };
}
