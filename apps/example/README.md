# synapse-chat example app

A minimal end-to-end demo showing how the three `@synapse-chat/*` packages compose into a runnable chat UI on top of the local `claude` CLI.

```
┌──────────────────────────┐
│ Browser  (Vite, port 5173)
│  ─────────────────────── │
│  @synapse-chat/react     │
│  @synapse-chat/core      │
└────────────┬─────────────┘
             │ WebSocket (port 8000, /ws)
             ▼
┌──────────────────────────┐
│ Node.js  (tsx, port 8000)│
│  ─────────────────────── │
│  ws (8.x)                │
│  @synapse-chat/server    │
│   ProcessManager +       │
│   parseStreamMessage     │
└────────────┬─────────────┘
             │ stdin / stdout (stream-json)
             ▼
┌──────────────────────────┐
│   claude CLI subprocess  │
└──────────────────────────┘
```

## Prerequisites

- Node.js ≥ 20
- The `claude` CLI installed and authenticated (or set `CLAUDE_CLI_PATH=/abs/path/to/claude` if it is not on `$PATH`)
- A working `npm install` at the repo root (this app is part of the vibe-admiral npm workspace)

## Run it

From the **vibe-admiral repo root**:

```bash
npm install                                  # workspace deps + ws + tsx
npm run build:synapse-chat                   # build core / server / react once
npm run dev --workspace=@synapse-chat/example
```

This starts two processes via `concurrently`:

- `vite` on http://localhost:5173 (the React UI)
- `tsx watch server/index.ts` on ws://localhost:8000/ws (the WS server)

Open http://localhost:5173 and type a message. The first message spawns `claude` via `ProcessManager.launchCommander()`; subsequent messages go through `pm.sendMessage()` over the same stdin pipe.

Click **Reset session** in the header to terminate the running CLI; the next message will spawn a fresh one.

## File map

| File | Role |
| --- | --- |
| `src/main.tsx` | React entry point. Mounts `<App />`. |
| `src/App.tsx` | The chat UI. Wires `useWebSocket`, `ChatMessage`, `ToolUseGroup`, `SessionInput`. |
| `src/index.css` | Tailwind v4 + the shadcn-compatible CSS variables `@synapse-chat/react` expects. |
| `server/index.ts` | WebSocket server. Owns one `ProcessManager` and one CLI process per WS connection. Demonstrates a custom `app:reset` handler. |
| `vite.config.ts` | React + Tailwind plugins, port 5173. |
| `tsconfig.{json,client,server}.json` | Split TS configs so the React JSX target and the Node.js target stay independent. |

## Wire protocol

The example follows the recommended baseline documented in
[../../docs/ws-protocol.md](../../docs/ws-protocol.md). At a glance:

| Direction | Message | Purpose |
| --- | --- | --- |
| C → S | `{ type: "user-message", content, images? }` | New turn from the user. |
| C → S | `{ type: "app:reset" }` | Custom command — kills the live CLI process. |
| C → S | `{ type: "pong" }` | Reply to server ping. |
| S → C | `{ type: "stream", message: StreamMessage }` | Each normalized stream-json event. |
| S → C | `{ type: "session-end", exitCode }` | The CLI subprocess exited. |
| S → C | `{ type: "ping" }` | Application-level keep-alive. |
| S → C | `{ type: "error", message, code? }` | Server-side problem (rate-limit, bad JSON, etc.). |

## Where to plug in your own backend

- **Different CLI** — swap `pm.launchCommander(...)` for your own `spawn(adapter.command, adapter.buildArgs(opts), …)` using your `CLIAdapter`. See [`../../docs/cli-adapter-guide.md`](../../docs/cli-adapter-guide.md).
- **Custom WS messages** — add cases to the `handleClientMessage` switch in `server/index.ts`. The `app:reset` branch is the template.
- **Auth** — wrap the `WebSocketServer` upgrade handler (e.g. with `@fastify/websocket` or your own `verifyClient`) before the framework code runs.
- **Persistence** — listen to `pm.on("data", …)` in your own collector and write to disk or a database. The framework does not own storage.

## Why this is small

- The framework provides every primitive — UI components, WSClient with reconnect, ProcessManager, stream parser, CLI adapters.
- The app provides only what the framework cannot know: the on-the-wire message shape, the spawn policy, and any custom commands.

If you want even less boilerplate, swap the manual `useWebSocket` + `useState` plumbing in `App.tsx` for the higher-level `useChat` hook (commit your own `decode` / `encode` and skip the optimistic local echo).

## License

MIT
