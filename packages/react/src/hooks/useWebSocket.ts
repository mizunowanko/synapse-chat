import { useEffect, useRef, useState } from "react";
import { WSClient, type WSClientOptions } from "../lib/ws-client.js";

export interface UseWebSocketResult<TServer, TClient> {
  /** The underlying `WSClient` instance. Stable across renders. */
  client: WSClient<TServer, TClient>;
  /** `true` once the socket is open, flips back to `false` on disconnect. */
  isConnected: boolean;
  /** Send a message over the socket. Drops the message if not connected. */
  send: (msg: TClient) => void;
}

/**
 * Hook that owns a {@link WSClient} for the lifetime of the component.
 *
 * - The client is created on first render from the passed options.
 * - Subsequent option changes do NOT recreate the client (by design — chat UIs
 *   typically want a stable connection across prop updates). Pass `key` on the
 *   parent component to force a fresh instance.
 * - Subscribes to connect events to maintain an `isConnected` flag.
 */
export function useWebSocket<TServer = unknown, TClient = unknown>(
  options: WSClientOptions<TServer, TClient>,
): UseWebSocketResult<TServer, TClient> {
  const clientRef = useRef<WSClient<TServer, TClient> | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new WSClient(options);
  }
  const client = clientRef.current;

  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const unsubConnect = client.onConnect(() => setIsConnected(true));
    client.connect();
    const poll = setInterval(() => {
      setIsConnected((prev) => (client.connected ? prev || true : false));
    }, 1000);
    return () => {
      unsubConnect();
      clearInterval(poll);
      client.disconnect();
    };
    // Client instance is stable; intentionally empty deps.
  }, [client]);

  return {
    client,
    isConnected,
    send: (msg) => client.send(msg),
  };
}
