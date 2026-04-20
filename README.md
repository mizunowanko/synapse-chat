# synapse-chat

An embeddable framework for wiring local AI CLIs (Claude Code, Gemini CLI, …) to a browser chat UI over WebSocket.

The framework provides the "glue" that is missing from existing AI-app stacks: a generic CLI process manager, a stream-json parser, a typed WebSocket client with reconnection, and a small set of React primitives for rendering streamed assistant output, tool calls, and image attachments.

> **Status**: Phase 4 — `core` + `server` + `react` ship runnable. Phase 6 adds documentation and a runnable [example app](./apps/example). The framework was originally incubated inside [vibe-admiral](https://github.com/mizunowanko/vibe-admiral) and spun out as this standalone repository; see that repo's ADR-0026 for historical design notes.

## Why?

Every existing chat-app SDK we surveyed (Vercel AI SDK, LangChain, Google ADK, Claude Agent SDK, …) assumes you call the model provider's HTTP API directly and pay per token. synapse-chat fills the opposite niche:

| | Existing SDKs | synapse-chat |
| --- | --- | --- |
| Backend | Provider HTTP API | Local CLI subprocess |
| Billing | Pay-per-token | User's existing CLI subscription |
| Supported CLIs | One vendor or none | Claude / Gemini / any CLI via adapter |
| UI + Server + Process | Each provided separately | One coherent set of packages |

If you want a desktop / localhost web UI that drives `claude` or `gemini` directly, this is the missing layer.

## Architecture

```
┌────────────────────────┐
│  Browser (your app)    │
│  ───────────────────   │
│  @synapse-chat/react   │
│  ChatMessage / Input   │
│  useChat / WSClient    │
└──────────┬─────────────┘
           │ WebSocket (your protocol)
           ▼
┌────────────────────────┐
│  Node.js (your server) │
│  ───────────────────   │
│  ws (your choice)      │
│  @synapse-chat/server  │
│  ProcessManager        │
│  CLIAdapter (Claude /  │
│  Gemini / custom)      │
└──────────┬─────────────┘
           │ stdin / stdout (stream-json)
           ▼
┌────────────────────────┐
│  Local CLI subprocess  │
│  claude / gemini / …   │
└────────────────────────┘
```

Each layer is independently consumable:

- Use just `@synapse-chat/server` if you have your own UI.
- Use just `@synapse-chat/react` if you front a different backend (REST / SSE / your own WS).
- Use just `@synapse-chat/core` if you want the shared types in your own framework.

## Packages

| Package | Description |
| --- | --- |
| [`@synapse-chat/core`](./packages/core) | Shared types (`StreamMessage`, `ImageAttachment`, `CLIAdapter`, `SessionOptions`, `ProcessManagerLike`). Dependency-free; safe to import from any environment. |
| [`@synapse-chat/server`](./packages/server) | Node.js `ProcessManager`, `stream-json` parser, generic `Supervisor`, and Claude / Gemini adapters. |
| [`@synapse-chat/react`](./packages/react) | React 18/19 chat primitives (`ChatMessage`, `ToolUseGroup`, `SessionInput`), `useChat` / `useWebSocket` hooks, and a generic `WSClient`. |
| [`@synapse-chat/mcp`](./packages/mcp) | MCP (Model Context Protocol) helpers: declarative HTTP-to-MCP tool proxies, stdio server scaffold, and Claude Code / Gemini CLI settings generators. Optional — pull in only when exposing a Backend to CLI agents. |

Dependency graph:

```
@synapse-chat/react   ──┐
@synapse-chat/mcp     ──┤──▶  @synapse-chat/core
@synapse-chat/server  ──┘
```

`server`, `react`, and `mcp` never depend on each other; pick whichever subset you need.

## Quickstart

The fastest way to see synapse-chat working is to run the bundled example app, which uses all three packages end-to-end:

```bash
# from the synapse-chat repo root
pnpm install                               # installs workspace deps
pnpm -r build                              # builds core/server/react
pnpm --filter @synapse-chat/example dev
# ── then open http://localhost:5173
```

The example spins up a WebSocket server on port 8000 that fronts the local `claude` CLI. Type into the input, the message is forwarded to the CLI, and the stream-json output is rendered through the React primitives.

For a hand-written walkthrough of each piece, see [`apps/example/README.md`](./apps/example/README.md).

### Minimal server snippet

```ts
import { ProcessManager, claudeAdapter } from "@synapse-chat/server";

const pm = new ProcessManager();
pm.on("data", (id, msg) => console.log(id, msg));
pm.dispatchSortie("session-1", process.cwd(), "Hello!", "investigate");
```

### Minimal React snippet

```tsx
import {
  ChatMessage,
  SessionInput,
  useChat,
  type StreamMessage,
} from "@synapse-chat/react";
import { useState } from "react";

export function App() {
  const [draft, setDraft] = useState("");
  const { messages, sendMessage, isConnected } = useChat<
    { type: "stream"; message: StreamMessage },
    { type: "user-message"; content: string }
  >({
    wsOptions: { url: "ws://localhost:8000/ws" },
    decode: (raw) => (raw.type === "stream" ? raw.message : null),
    encode: (text) => ({ type: "user-message", content: text }),
  });

  return (
    <>
      {messages.map((m, i) => (
        <ChatMessage key={i} message={m} />
      ))}
      <SessionInput
        value={draft}
        onChange={setDraft}
        onSend={(text) => {
          sendMessage(text);
          setDraft("");
        }}
        disabled={!isConnected}
      />
    </>
  );
}
```

## Documentation

| Document | Topic |
| --- | --- |
| [docs/cli-adapter-guide.md](./docs/cli-adapter-guide.md) | Implementing a `CLIAdapter` for a new CLI (annotated `claudeAdapter` walkthrough + worked example for a hypothetical `myllm` CLI). |
| [docs/mcp-helper-guide.md](./docs/mcp-helper-guide.md) | Exposing a Backend HTTP API to CLI agents via `@synapse-chat/mcp`: `defineHttpTool`, `createMcpServer`, settings-file generators, confirmation guard. |
| [docs/ws-protocol.md](./docs/ws-protocol.md) | The WebSocket message protocol used by the example app. Recommended baseline for new apps; not enforced by the framework itself. |
| [apps/example/README.md](./apps/example/README.md) | How to run the example, where to plug in your own backend, and how to add custom WS message handlers. |
| TypeDoc API reference | Run `pnpm docs:api` from the repo root to generate HTML at `docs/api/`. The output is gitignored. |

## Layout

```
synapse-chat/
├── packages/
│   ├── core/        # @synapse-chat/core — types
│   ├── server/      # @synapse-chat/server — ProcessManager, adapters, supervisor
│   ├── react/       # @synapse-chat/react — UI primitives + WSClient
│   └── mcp/         # @synapse-chat/mcp — MCP tool proxies + CLI settings generators
├── apps/
│   └── example/     # End-to-end runnable demo (Vite + ws + claude CLI)
├── docs/
│   ├── cli-adapter-guide.md
│   ├── ws-protocol.md
│   └── api/         # TypeDoc output (gitignored)
├── .changeset/      # semver changelogs
├── .github/
├── pnpm-workspace.yaml  # synapse-chat-only workspace (when used standalone)
├── tsconfig.base.json
├── typedoc.json
└── package.json
```

## Development

synapse-chat is a standalone pnpm monorepo. `pnpm 9+` is required.

```bash
cd synapse-chat
pnpm install
pnpm -r build        # tsc -b across core/server/react
pnpm -r test
pnpm -r typecheck
pnpm lint
```

### Using from a sibling project (e.g. vibe-admiral)

Consuming projects can reference synapse-chat via `file:` dependencies while the packages are not yet published to npm. Both repos should live as siblings under a shared directory (for example `~/Projects/Application/`):

```
~/Projects/Application/
  synapse-chat/        ← this repo
  your-app/            ← consumer (e.g. vibe-admiral)
```

In the consumer's `package.json`:

```json
{
  "dependencies": {
    "@synapse-chat/core":   "file:../synapse-chat/packages/core",
    "@synapse-chat/react":  "file:../synapse-chat/packages/react",
    "@synapse-chat/server": "file:../synapse-chat/packages/server"
  }
}
```

Before running the consumer's `npm install`, build the synapse-chat packages once:

```bash
cd ~/Projects/Application/synapse-chat
pnpm install
pnpm -r build
```

Then `npm install` in the consumer picks up the pre-built `dist/` output of each package.

## Releasing

Versioning is managed by [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset          # record a change
pnpm version            # bump versions + write CHANGELOG
pnpm release            # build + publish (publish target not wired yet)
```

## License

MIT
