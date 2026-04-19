import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChatMessage,
  SessionInput,
  ToolUseGroup,
  groupToolMessages,
  isToolGroup,
  useWebSocket,
  type ImageAttachment,
  type StreamMessage,
  type WSClientOptions,
} from "@synapse-chat/react";

/* ────────────────────────────────────────────────────────────────────────── */
/* Wire protocol — see synapse-chat/docs/ws-protocol.md                       */
/* ────────────────────────────────────────────────────────────────────────── */

type ServerMessage =
  | { type: "stream"; message: StreamMessage }
  | { type: "session-end"; exitCode: number | null }
  | { type: "ping" }
  | { type: "error"; message: string; code?: string };

type ClientMessage =
  | { type: "user-message"; content: string; images?: ImageAttachment[] }
  | { type: "app:reset" }
  | { type: "pong" };

// Hoisted to module scope so the WSClient ref inside useWebSocket stays stable
// across re-renders. Mutating this object after first render has no effect.
const WS_OPTIONS: WSClientOptions<ServerMessage, ClientMessage> = {
  url: "ws://localhost:8000/ws",
  pingType: "ping",
  pongMessage: { type: "pong" },
};

/* ────────────────────────────────────────────────────────────────────────── */
/* App                                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

export function App() {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const { client, isConnected, send } = useWebSocket(WS_OPTIONS);

  // Subscribe once to the socket, route every server frame.
  useEffect(() => {
    return client.onMessage((raw) => {
      switch (raw.type) {
        case "stream":
          setMessages((prev) => [...prev, raw.message]);
          return;
        case "session-end":
          setStatusBanner(`Claude exited (code ${raw.exitCode ?? "n/a"})`);
          return;
        case "error":
          setMessages((prev) => [
            ...prev,
            { type: "error", content: raw.message, subtype: raw.code },
          ]);
          return;
        case "ping":
          // Auto-handled by WSClient via pingType: "ping".
          return;
      }
    });
  }, [client]);

  const handleSend = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && (!images || images.length === 0)) return;

      // Optimistic local echo: render the user's own message immediately.
      // The server may also echo a `user` StreamMessage; either is fine —
      // ChatMessage renders both as the user's bubble.
      setMessages((prev) => [
        ...prev,
        { type: "user", content: trimmed, images, timestamp: Date.now() },
      ]);

      send(
        images && images.length > 0
          ? { type: "user-message", content: trimmed, images }
          : { type: "user-message", content: trimmed },
      );
      setDraft("");
    },
    [send],
  );

  const handleReset = useCallback(() => {
    send({ type: "app:reset" });
    setMessages([]);
    setStatusBanner("Session reset.");
  }, [send]);

  const groups = useMemo(() => groupToolMessages(messages), [messages]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">synapse-chat example</h1>
          <p className="text-xs text-muted-foreground">
            React + Vite + ws + claude CLI
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span
            className={
              isConnected
                ? "rounded bg-accent px-2 py-1 text-accent-foreground"
                : "rounded bg-destructive px-2 py-1 text-destructive-foreground"
            }
          >
            {isConnected ? "connected" : "disconnected"}
          </span>
          <button
            type="button"
            onClick={handleReset}
            className="rounded border border-input px-2 py-1 hover:bg-accent"
          >
            Reset session
          </button>
        </div>
      </header>

      {statusBanner && (
        <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
          {statusBanner}
        </div>
      )}

      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Type a message below to start a Claude CLI session. The server
              will spawn <code>claude</code> on first send.
            </p>
          )}

          {groups.map((item, i) => {
            if (isToolGroup(item)) {
              return <ToolUseGroup key={`tools-${i}`} group={item} />;
            }
            return (
              <ChatMessage
                key={`msg-${i}`}
                message={item}
                renderSystem={(m) =>
                  m.subtype === "status" ? (
                    <div className="text-xs italic text-muted-foreground">
                      {m.content}
                    </div>
                  ) : null
                }
              />
            );
          })}
        </div>
      </main>

      <footer className="border-t border-border bg-card p-3">
        <div className="mx-auto max-w-3xl">
          <SessionInput
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            disabled={!isConnected}
            placeholder={
              isConnected ? "Send a message to claude…" : "Waiting for WebSocket…"
            }
          />
        </div>
      </footer>
    </div>
  );
}
