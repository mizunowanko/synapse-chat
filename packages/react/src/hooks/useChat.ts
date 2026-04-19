import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ImageAttachment, StreamMessage } from "@synapse-chat/core";
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
  /** Seed the chat (e.g. from persisted history). */
  initialMessages?: readonly StreamMessage[];
}

export interface UseChatResult {
  /** Messages in display order. */
  messages: StreamMessage[];
  /** Replace the message list wholesale (e.g. to load history). */
  setMessages: Dispatch<SetStateAction<StreamMessage[]>>;
  /** Append a single message locally (e.g. optimistic user echo). */
  appendMessage: (msg: StreamMessage) => void;
  /** Clear all messages. */
  clear: () => void;
  /** Send a user message through the socket. */
  sendMessage: (text: string, images?: ImageAttachment[]) => void;
  /** `true` while the socket is open. */
  isConnected: boolean;
}

function defaultEncode<TClient>(text: string, images?: ImageAttachment[]): TClient {
  const payload: Record<string, unknown> = { type: "chat", content: text };
  if (images && images.length > 0) payload.images = images;
  return payload as TClient;
}

/**
 * High-level chat hook. Combines a WebSocket connection, a decoder for
 * incoming messages, and a send helper keyed on `(text, images)` tuples.
 *
 * The hook is deliberately thin — it does not buffer partial streams,
 * deduplicate, or persist history. Apps layer those concerns on top using
 * {@link setMessages} / {@link appendMessage}.
 */
export function useChat<TServer = unknown, TClient = unknown>(
  options: UseChatOptions<TServer, TClient>,
): UseChatResult {
  const { wsOptions, decode, encode, initialMessages } = options;
  const encoder = encode ?? defaultEncode<TClient>;

  const { client, isConnected, send } = useWebSocket<TServer, TClient>(wsOptions);
  const [messages, setMessages] = useState<StreamMessage[]>(() =>
    initialMessages ? [...initialMessages] : [],
  );

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
  }, []);

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
  };
}
