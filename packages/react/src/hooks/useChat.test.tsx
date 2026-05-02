import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ChatStorage, StreamMessage } from "@synapse-chat/core";
import { useChat } from "./useChat.js";

type MessageHandler = (raw: unknown) => void;

interface FakeClient {
  onMessage: (h: MessageHandler) => () => void;
  emit: (raw: unknown) => void;
}

function makeFakeClient(): FakeClient {
  const handlers = new Set<MessageHandler>();
  return {
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    emit: (raw) => {
      for (const h of handlers) h(raw);
    },
  };
}

// Hoisted so the `vi.mock` factory can see it. The `client` object is created
// once and reused across calls to mirror useWebSocket's `useRef` semantics —
// consumers rely on `client` being referentially stable across renders.
const fakeClient = vi.hoisted(() => {
  const messageHandlers = new Set<(raw: unknown) => void>();
  const statusHandlers = new Set<
    (s: "disconnected" | "reconnecting" | "connected") => void
  >();
  let currentStatus: "disconnected" | "reconnecting" | "connected" = "connected";

  const onMessage = (h: (raw: unknown) => void) => {
    messageHandlers.add(h);
    return () => messageHandlers.delete(h);
  };
  const onStatusChange = (
    h: (s: "disconnected" | "reconnecting" | "connected") => void,
  ) => {
    statusHandlers.add(h);
    return () => statusHandlers.delete(h);
  };
  const clientSend = vi.fn();

  const client = {
    onMessage,
    onStatusChange,
    send: clientSend,
    get status() {
      return currentStatus;
    },
  };

  return {
    messageHandlers,
    statusHandlers,
    getStatus: () => currentStatus,
    setStatus: (next: "disconnected" | "reconnecting" | "connected") => {
      currentStatus = next;
      for (const h of statusHandlers) h(next);
    },
    onMessage,
    onStatusChange,
    client,
    clientSend,
    send: vi.fn(() => true),
  };
});

vi.mock("./useWebSocket.js", () => ({
  useWebSocket: () => ({
    client: fakeClient.client,
    isConnected: fakeClient.getStatus() === "connected",
    connectionStatus: fakeClient.getStatus(),
    send: fakeClient.send,
  }),
}));

afterEach(() => {
  cleanup();
  fakeClient.messageHandlers.clear();
  fakeClient.statusHandlers.clear();
  fakeClient.send.mockReset();
  fakeClient.send.mockImplementation(() => true);
  fakeClient.clientSend.mockReset();
  fakeClient.setStatus("connected");
});

const wsOptions = { url: "ws://test" };
const decode = (raw: unknown): StreamMessage | null => raw as StreamMessage;

function makeStorage(seed: Record<string, StreamMessage[] | null> = {}): {
  storage: ChatStorage<StreamMessage>;
  save: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  data: Record<string, StreamMessage[] | null>;
} {
  const data: Record<string, StreamMessage[] | null> = { ...seed };
  const save = vi.fn(async (id: string, msgs: readonly StreamMessage[]) => {
    data[id] = [...msgs];
  });
  const load = vi.fn(async (id: string) => data[id] ?? null);
  const clear = vi.fn(async (id: string) => {
    delete data[id];
  });
  return { storage: { save, load, clear }, save, load, clear, data };
}

describe("useChat — backward compatibility", () => {
  it("works with no storage and seeds from initialMessages", () => {
    const initial: StreamMessage[] = [{ type: "user", content: "seed" }];
    const { result } = renderHook(() =>
      useChat({ wsOptions, decode, initialMessages: initial }),
    );
    expect(result.current.messages).toEqual(initial);
    expect(result.current.isHydrating).toBe(false);
  });

  it("appends decoded messages from the websocket", () => {
    const { result } = renderHook(() => useChat({ wsOptions, decode }));
    act(() => {
      for (const h of fakeClient.messageHandlers)
        h({ type: "assistant", content: "yo" });
    });
    expect(result.current.messages).toEqual([{ type: "assistant", content: "yo" }]);
  });
});

describe("useChat — storage integration", () => {
  it("hydrates from storage on mount and exposes isHydrating", async () => {
    const stored: StreamMessage[] = [
      { type: "user", content: "old-q" },
      { type: "assistant", content: "old-a" },
    ];
    const { storage, load } = makeStorage({ s1: stored });
    const { result } = renderHook(() =>
      useChat({
        wsOptions,
        decode,
        storage,
        sessionId: "s1",
        saveDebounceMs: 0,
      }),
    );

    expect(result.current.isHydrating).toBe(true);
    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    expect(result.current.messages).toEqual(stored);
    expect(load).toHaveBeenCalledWith("s1");
  });

  it("falls back to initialMessages when storage.load returns null", async () => {
    const { storage } = makeStorage({ s1: null });
    const initial: StreamMessage[] = [{ type: "system", content: "fresh" }];
    const { result } = renderHook(() =>
      useChat({
        wsOptions,
        decode,
        initialMessages: initial,
        storage,
        sessionId: "s1",
        saveDebounceMs: 0,
      }),
    );
    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    expect(result.current.messages).toEqual(initial);
  });

  it("does not save the empty initial state before hydration completes", async () => {
    const { storage, save } = makeStorage({ s1: [{ type: "user", content: "keep" }] });
    renderHook(() =>
      useChat({ wsOptions, decode, storage, sessionId: "s1", saveDebounceMs: 0 }),
    );

    // If the empty initial state leaked through, save would have been called
    // with [] before hydration resolved. Wait one tick past hydration and
    // assert the only save calls carry the hydrated value.
    await waitFor(() => expect(save).toHaveBeenCalled());
    for (const call of save.mock.calls) {
      expect(call[1]).not.toEqual([]);
    }
  });

  it("persists new messages after hydration", async () => {
    const { storage, save } = makeStorage();
    const { result } = renderHook(() =>
      useChat({ wsOptions, decode, storage, sessionId: "s1", saveDebounceMs: 0 }),
    );
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    act(() => {
      result.current.appendMessage({ type: "user", content: "new" });
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    const lastCall = save.mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual([{ type: "user", content: "new" }]);
  });

  it("clears storage when clear() is called", async () => {
    const { storage, clear } = makeStorage({
      s1: [{ type: "user", content: "x" }],
    });
    const { result } = renderHook(() =>
      useChat({ wsOptions, decode, storage, sessionId: "s1", saveDebounceMs: 0 }),
    );
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    act(() => {
      result.current.clear();
    });
    expect(result.current.messages).toEqual([]);
    await waitFor(() => expect(clear).toHaveBeenCalledWith("s1"));
  });

  it("re-hydrates when sessionId changes", async () => {
    const { storage, load } = makeStorage({
      a: [{ type: "user", content: "from-a" }],
      b: [{ type: "user", content: "from-b" }],
    });
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useChat({ wsOptions, decode, storage, sessionId, saveDebounceMs: 0 }),
      { initialProps: { sessionId: "a" } },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]?.content).toBe("from-a");

    rerender({ sessionId: "b" });
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe("from-b"),
    );
    expect(load).toHaveBeenCalledWith("a");
    expect(load).toHaveBeenCalledWith("b");
  });

  it("does not treat storage-without-sessionId as enabled", () => {
    const { storage, load } = makeStorage();
    const { result } = renderHook(() => useChat({ wsOptions, decode, storage }));
    expect(result.current.isHydrating).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("useChat — client exposure (issue #8)", () => {
  it("exposes the underlying WSClient on the result", () => {
    const { result } = renderHook(() => useChat({ wsOptions, decode }));
    expect(result.current.client).toBeDefined();
    expect(typeof result.current.client.send).toBe("function");
  });

  it("returns a stable client across re-renders", () => {
    const { result, rerender } = renderHook(() =>
      useChat({ wsOptions, decode }),
    );
    const first = result.current.client;
    rerender();
    expect(result.current.client).toBe(first);
  });

  it("forwards arbitrary messages through client.send without re-encoding", () => {
    const { result } = renderHook(() => useChat({ wsOptions, decode }));
    const raw = { type: "app:reset" };
    act(() => {
      result.current.client.send(raw);
    });
    expect(fakeClient.clientSend).toHaveBeenCalledWith(raw);
    expect(fakeClient.send).not.toHaveBeenCalled();
  });
});

describe("useChat — optimistic send (online)", () => {
  it("appends a pending user message synchronously and marks it sent on success", () => {
    const { result } = renderHook(() => useChat({ wsOptions, decode }));

    let id: string;
    act(() => {
      id = result.current.sendMessage("hello");
    });

    expect(fakeClient.send).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(1);
    const msg = result.current.messages[0];
    expect(msg?.type).toBe("user");
    expect(msg?.content).toBe("hello");
    expect(msg?.meta?.clientMessageId).toBe(id!);
    // Without ackPredicate, the entry transitions to "sent" immediately.
    expect(msg?.meta?.optimisticStatus).toBe("sent");
    expect(result.current.pendingMessageIds).toEqual([]);
  });

  it("includes images on the optimistic message and the wire payload", () => {
    const { result } = renderHook(() => useChat({ wsOptions, decode }));
    const images = [
      { base64: "abc", mediaType: "image/png" as const },
    ];

    act(() => {
      result.current.sendMessage("look", images);
    });

    expect(result.current.messages[0]?.images).toEqual(images);
    const sent = fakeClient.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.images).toEqual(images);
    expect(sent.content).toBe("look");
    expect(typeof sent.clientMessageId).toBe("string");
  });

  it("uses a custom encoder when provided", () => {
    const encode = vi.fn(
      (text: string, _images: unknown, id: string) => ({
        kind: "msg",
        text,
        id,
      }),
    );
    const { result } = renderHook(() =>
      useChat({ wsOptions, decode, encode }),
    );

    act(() => {
      result.current.sendMessage("custom");
    });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(fakeClient.send.mock.calls[0]?.[0]).toMatchObject({
      kind: "msg",
      text: "custom",
    });
  });
});

describe("useChat — optimistic send (offline + retry)", () => {
  it("queues messages while offline and flushes them on reconnect", () => {
    fakeClient.setStatus("reconnecting");
    fakeClient.send.mockImplementation(() => false);

    const { result } = renderHook(() => useChat({ wsOptions, decode }));

    act(() => {
      result.current.sendMessage("offline-1");
      result.current.sendMessage("offline-2");
    });

    expect(result.current.pendingMessageIds).toHaveLength(2);
    expect(result.current.messages).toHaveLength(2);
    for (const m of result.current.messages) {
      expect(m.meta?.optimisticStatus).toBe("pending");
    }
    expect(fakeClient.send).toHaveBeenCalledTimes(2); // both attempts dropped

    // Come back online — the status subscription flushes the queue.
    fakeClient.send.mockImplementation(() => true);
    act(() => {
      fakeClient.setStatus("connected");
    });

    expect(result.current.pendingMessageIds).toEqual([]);
    expect(result.current.messages).toHaveLength(2);
    for (const m of result.current.messages) {
      expect(m.meta?.optimisticStatus).toBe("sent");
    }
    // 2 initial attempts + 2 reconnect flush attempts.
    expect(fakeClient.send).toHaveBeenCalledTimes(4);
  });

  it("rolls back and fires onSendError after maxRetries reconnect cycles fail", () => {
    fakeClient.setStatus("reconnecting");
    fakeClient.send.mockImplementation(() => false);
    const onSendError = vi.fn();

    const { result } = renderHook(() =>
      useChat({ wsOptions, decode, maxRetries: 2, onSendError }),
    );

    act(() => {
      result.current.sendMessage("doomed");
    });
    expect(result.current.messages).toHaveLength(1);

    // Two reconnect cycles, both failing — second one trips maxRetries.
    act(() => {
      fakeClient.setStatus("connected");
    });
    expect(onSendError).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);

    act(() => {
      fakeClient.setStatus("reconnecting");
    });
    act(() => {
      fakeClient.setStatus("connected");
    });

    expect(onSendError).toHaveBeenCalledTimes(1);
    expect(onSendError.mock.calls[0]?.[0]?.content).toBe("doomed");
    expect(onSendError.mock.calls[0]?.[1]).toBe("max-retries-exceeded");
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.pendingMessageIds).toEqual([]);
  });

  it("clear() drops pending entries without firing onSendError", () => {
    fakeClient.setStatus("reconnecting");
    fakeClient.send.mockImplementation(() => false);
    const onSendError = vi.fn();
    const { result } = renderHook(() =>
      useChat({ wsOptions, decode, onSendError }),
    );

    act(() => {
      result.current.sendMessage("never-mind");
    });
    expect(result.current.pendingMessageIds).toHaveLength(1);

    act(() => {
      result.current.clear();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.pendingMessageIds).toEqual([]);

    // A subsequent reconnect must not resurrect the cleared entry.
    fakeClient.send.mockImplementation(() => true);
    act(() => {
      fakeClient.setStatus("connected");
    });
    expect(fakeClient.send).toHaveBeenCalledTimes(1); // only the original failed attempt
    expect(onSendError).not.toHaveBeenCalled();
  });
});

describe("useChat — ack predicate", () => {
  it("removes the optimistic placeholder when the server acks the message", () => {
    const ackPredicate = (raw: unknown) => {
      const r = raw as { type?: string; ackId?: string };
      return r.type === "ack" && typeof r.ackId === "string" ? r.ackId : null;
    };
    const { result } = renderHook(() =>
      useChat({
        wsOptions,
        decode: (raw) => {
          const r = raw as { type?: string };
          // Drop ack frames from the rendered list.
          return r.type === "ack" ? null : (raw as StreamMessage);
        },
        ackPredicate,
      }),
    );

    let id: string;
    act(() => {
      id = result.current.sendMessage("ping?");
    });
    // With ackPredicate set, the optimistic entry stays "pending" until the ack.
    expect(result.current.messages[0]?.meta?.optimisticStatus).toBe("pending");
    expect(result.current.pendingMessageIds).toEqual([id!]);

    act(() => {
      for (const h of fakeClient.messageHandlers) h({ type: "ack", ackId: id! });
    });

    expect(result.current.pendingMessageIds).toEqual([]);
    expect(result.current.messages).toEqual([]); // optimistic placeholder dropped
  });
});

describe("useChat — fake client helper reuses MessageHandler", () => {
  // Sanity: confirm the helper matches the interface WSClient exposes.
  it("constructs a fake client shape", () => {
    const c = makeFakeClient();
    const received: unknown[] = [];
    const unsub = c.onMessage((m) => received.push(m));
    c.emit({ hello: 1 });
    unsub();
    c.emit({ hello: 2 });
    expect(received).toEqual([{ hello: 1 }]);
  });
});
