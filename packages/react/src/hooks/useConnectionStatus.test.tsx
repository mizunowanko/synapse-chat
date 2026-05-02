import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ConnectionStatus, WSClient } from "../lib/ws-client.js";
import { useConnectionStatus } from "./useConnectionStatus.js";

type StatusHandler = (s: ConnectionStatus) => void;

function makeFakeClient(initial: ConnectionStatus = "disconnected"): {
  client: WSClient;
  set: (s: ConnectionStatus) => void;
  handlers: Set<StatusHandler>;
} {
  let status: ConnectionStatus = initial;
  const handlers = new Set<StatusHandler>();
  const client = {
    get status() {
      return status;
    },
    onStatusChange(h: StatusHandler) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  } as unknown as WSClient;
  return {
    client,
    handlers,
    set: (next) => {
      status = next;
      for (const h of handlers) h(next);
    },
  };
}

afterEach(() => cleanup());

describe("useConnectionStatus", () => {
  it("seeds from client.status on mount", () => {
    const { client } = makeFakeClient("connected");
    const { result } = renderHook(() => useConnectionStatus(client));
    expect(result.current).toBe("connected");
  });

  it("updates when the client transitions", () => {
    const { client, set } = makeFakeClient("disconnected");
    const { result } = renderHook(() => useConnectionStatus(client));

    act(() => set("reconnecting"));
    expect(result.current).toBe("reconnecting");

    act(() => set("connected"));
    expect(result.current).toBe("connected");
  });

  it("unsubscribes on unmount", () => {
    const { client, set, handlers } = makeFakeClient("connected");
    const { unmount } = renderHook(() => useConnectionStatus(client));
    expect(handlers.size).toBe(1);
    unmount();
    expect(handlers.size).toBe(0);
    // Calling set after unmount must not throw or update anything observable.
    set("disconnected");
  });
});
