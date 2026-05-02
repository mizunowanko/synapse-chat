import { useEffect, useState } from "react";
import type { ConnectionStatus, WSClient } from "../lib/ws-client.js";

/**
 * Subscribe to a {@link WSClient}'s lifecycle and return its current
 * {@link ConnectionStatus} as React state.
 *
 * Pass the `client` returned by {@link useWebSocket} (or any other WSClient
 * instance you own). The hook seeds the initial value from `client.status`,
 * so you get the right state even if the client transitioned before the
 * effect attached.
 */
export function useConnectionStatus<TServer = unknown, TClient = unknown>(
  client: WSClient<TServer, TClient>,
): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => client.status);

  useEffect(() => {
    // Re-seed when the client identity changes (rare, but possible if a
    // consumer swaps the WSClient instance).
    setStatus(client.status);
    return client.onStatusChange(setStatus);
  }, [client]);

  return status;
}
