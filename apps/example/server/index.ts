/**
 * Minimal WebSocket server for the synapse-chat example.
 *
 * Spawns Claude CLI on demand via @synapse-chat/server's ProcessManager,
 * and pipes stream-json events to the connected browser as `stream` frames.
 *
 * Wire protocol: see synapse-chat/docs/ws-protocol.md.
 */
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { ProcessManager, parseStreamMessage } from "@synapse-chat/server";
import type { ImageAttachment, StreamMessage } from "@synapse-chat/core";

const PORT = Number(process.env.PORT ?? 8000);
const PING_INTERVAL_MS = 30_000;

/* ────────────────────────────────────────────────────────────────────────── */
/* Wire protocol types (mirrors apps/example/src/App.tsx)                     */
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

/* ────────────────────────────────────────────────────────────────────────── */
/* One process-per-WS-connection. Real apps probably want a session registry. */
/* ────────────────────────────────────────────────────────────────────────── */

const pm = new ProcessManager();

interface ConnectionState {
  ws: WebSocket;
  processId: string | null;
}

const connections = new Map<string, ConnectionState>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcastStream(connId: string, message: StreamMessage): void {
  const conn = connections.get(connId);
  if (!conn) return;
  send(conn.ws, { type: "stream", message });
}

// ProcessManager is one-per-server; route events back to whichever connection
// owns the process id.
pm.on("data", (id, raw) => {
  const conn = findConnByProcessId(id);
  if (!conn) return;
  // ProcessManager emits the raw JSON line (Record<string, unknown>).
  // Normalize it to a StreamMessage before forwarding so the browser sees
  // the same shape an adapter would produce.
  const message = parseStreamMessage(raw);
  if (!message) return;
  broadcastStream(conn.id, message);
});

pm.on("exit", (id, code) => {
  const conn = findConnByProcessId(id);
  if (!conn) return;
  send(conn.state.ws, { type: "session-end", exitCode: code });
  conn.state.processId = null;
});

pm.on("error", (id, err) => {
  const conn = findConnByProcessId(id);
  if (!conn) return;
  send(conn.state.ws, { type: "error", message: err.message });
});

pm.on("rate-limit", (id) => {
  const conn = findConnByProcessId(id);
  if (!conn) return;
  send(conn.state.ws, {
    type: "error",
    message: "Claude CLI is rate-limited. Retry shortly.",
    code: "rate-limit",
  });
});

function findConnByProcessId(
  processId: string,
): { id: string; state: ConnectionState } | null {
  for (const [id, state] of connections) {
    if (state.processId === processId) return { id, state };
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* WS lifecycle                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

const wss = new WebSocketServer({ port: PORT, path: "/ws" });

wss.on("connection", (ws) => {
  const connId = randomUUID();
  connections.set(connId, { ws, processId: null });
  console.log(`[ws] connection ${connId} opened (active=${connections.size})`);

  // Application-level keep-alive (independent of the WebSocket protocol ping).
  const pingTimer = setInterval(() => send(ws, { type: "ping" }), PING_INTERVAL_MS);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "invalid JSON" });
      return;
    }

    handleClientMessage(connId, msg);
  });

  ws.on("close", () => {
    clearInterval(pingTimer);
    const state = connections.get(connId);
    if (state?.processId) pm.kill(state.processId);
    connections.delete(connId);
    console.log(`[ws] connection ${connId} closed (active=${connections.size})`);
  });

  ws.on("error", (err) => {
    console.error(`[ws] connection ${connId} error:`, err);
  });
});

function handleClientMessage(connId: string, msg: ClientMessage): void {
  const state = connections.get(connId);
  if (!state) return;

  switch (msg.type) {
    case "user-message":
      handleUserMessage(state, connId, msg.content, msg.images);
      return;

    case "app:reset":
      // Custom message handler example: tear down the live session so the
      // next user-message gets a fresh CLI process.
      if (state.processId) {
        pm.kill(state.processId);
        state.processId = null;
      }
      return;

    case "pong":
      // Client acknowledged our ping; nothing else to do.
      return;
  }
}

function handleUserMessage(
  state: ConnectionState,
  connId: string,
  content: string,
  images?: ImageAttachment[],
): void {
  // First message: spawn an interactive Claude session for this connection.
  if (!state.processId) {
    const processId = `example-${connId}`;
    state.processId = processId;
    pm.launchCommander(
      processId,
      process.cwd(),
      [],
      "You are a helpful assistant powering a synapse-chat example app.",
    );
  }

  // Forward to the running CLI's stdin.
  const result = pm.sendMessage(state.processId, content, images);
  if (!result.ok) {
    send(state.ws, {
      type: "error",
      message: `Failed to deliver message: ${result.reason}`,
      code: result.reason,
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Lifecycle                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

console.log(`[example] WebSocket server listening on ws://localhost:${PORT}/ws`);

function shutdown(signal: string): void {
  console.log(`[example] received ${signal}, shutting down…`);
  pm.killAll();
  wss.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
