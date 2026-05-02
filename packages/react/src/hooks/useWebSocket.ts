import { useEffect, useRef, useState } from "react";
import {
  WSClient,
  type ConnectionStatus,
  type WSClientOptions,
} from "../lib/ws-client.js";

export interface UseWebSocketResult<TServer, TClient> {
  /** The underlying `WSClient` instance. Stable across renders. */
  client: WSClient<TServer, TClient>;
  /** `true` once the socket is open, flips back to `false` on disconnect. */
  isConnected: boolean;
  /**
   * Fine-grained lifecycle phase. Distinguishes "trying to come back" from
   * "fully idle" — useful for offline indicators.
   */
  connectionStatus: ConnectionStatus;
  /**
   * Send a message over the socket. Returns `true` when the payload was
   * handed off to the socket, `false` when it was dropped because the
   * socket was not open.
   */
  send: (msg: TClient) => boolean;
}

/**
 * Hook that owns a {@link WSClient} for the lifetime of the component.
 *
 * - The client is created on first render from the passed options.
 * - Subsequent option changes do NOT recreate the client (by design — chat UIs
 *   typically want a stable connection across prop updates). Pass `key` on the
 *   parent component to force a fresh instance.
 * - Subscribes to status changes to maintain `connectionStatus` and the
 *   derived `isConnected` flag.
 */
export function useWebSocket<TServer = unknown, TClient = unknown>(
  options: WSClientOptions<TServer, TClient>,
): UseWebSocketResult<TServer, TClient> {
  const clientRef = useRef<WSClient<TServer, TClient> | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new WSClient(options);
  }
  const client = clientRef.current;

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    () => client.status,
  );

  useEffect(() => {
    // Seed from the client in case its status changed between hook init
    // and effect run (e.g. StrictMode double-invocation).
    setConnectionStatus(client.status);
    const unsubStatus = client.onStatusChange(setConnectionStatus);
    client.connect();
    return () => {
      unsubStatus();
      client.disconnect();
    };
    // Client instance is stable; intentionally a single dep.
  }, [client]);

  return {
    client,
    isConnected: connectionStatus === "connected",
    connectionStatus,
    send: (msg) => client.send(msg),
  };
}
