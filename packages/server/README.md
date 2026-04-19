# @synapse-chat/server

Node.js runtime pieces for wiring an AI CLI subprocess (Claude, Gemini, …) to a chat application.

> **Status**: Phase 4 — `ProcessManager`, stream parser, supervisor, and Claude / Gemini CLI adapters are in. APIs are still pre-1.0; expect the surface to be tightened up as more apps embed the package. See [ADR-0026](../../../adr/0026-ai-chat-web-ui-framework.md).

## What's inside

| Module | Purpose |
| --- | --- |
| `ProcessManager` | Spawn / stream / kill Claude CLI subprocesses. Emits `spawn` / `data` / `exit` / `error` / `rate-limit` events. Implements `ProcessManagerLike`. |
| `parseStreamMessage` / `extractSessionId` / `extractResultUsage` | Normalize Claude CLI's `stream-json` output into a `StreamMessage`. |
| `attachStdoutProcessor` / `attachStderrProcessor` | Line-buffered JSON parsing helpers. Used by `ProcessManager`; safe to use directly when wiring your own subprocess. |
| `safeJsonParse` | Best-effort JSON parser used inside the package; exposed for symmetry with stdout parsing. |
| `claudeAdapter` / `geminiAdapter` | Concrete `CLIAdapter` implementations. Provide `command`, `buildArgs`, `parseOutput`, `formatInput`, plus rate-limit / retryable patterns. Re-exported from `./adapters`. |
| `IpcProcessManager` | `ProcessManagerLike` proxy that forwards commands over a Node.js `fork()` IPC channel to a worker. |
| `startSupervisor` | Generic supervisor entry that forks a PM worker + a WS server child and restarts them with exponential backoff. Available via `@synapse-chat/server/supervisor`. |

## Install

```bash
npm install @synapse-chat/server @synapse-chat/core
# or
pnpm add @synapse-chat/server @synapse-chat/core
```

## Usage

### Direct subprocess use

```ts
import { ProcessManager, claudeAdapter } from "@synapse-chat/server";

const pm = new ProcessManager();

pm.on("data", (id, msg) => console.log(id, msg));
pm.on("exit", (id, code) => console.log(`${id} exited with ${code}`));

pm.dispatchSortie(
  "session-1",
  process.cwd(),
  "Summarize this directory",
  "investigate",
);
```

### Via a CLI adapter

`ProcessManager` is wired to the Claude CLI directly. To drive a different CLI (e.g. Gemini, your own binary) compose the adapter with your own `spawn` call:

```ts
import { spawn } from "node:child_process";
import { geminiAdapter } from "@synapse-chat/server";

const args = geminiAdapter.buildArgs({ prompt: "Hello" });
const proc = spawn(geminiAdapter.command, args, { stdio: ["pipe", "pipe", "pipe"] });

proc.stdout?.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    const msg = geminiAdapter.parseOutput(line);
    if (msg) console.log(msg);
  }
});
```

For a complete walkthrough on writing your own `CLIAdapter`, see
[`docs/cli-adapter-guide.md`](../../docs/cli-adapter-guide.md).

### Supervisor (long-running apps)

`startSupervisor()` is for apps that want a parent process babysitting two children: a process-manager worker and a WS server. Both are forked, monitored, and restarted with exponential backoff:

```ts
import { startSupervisor } from "@synapse-chat/server/supervisor";

const handle = startSupervisor({
  port: 9721,
  pmWorkerScript: "/abs/path/to/pm-worker.js",
  wsServerChildScript: "/abs/path/to/ws-server.js",
  childEnv: { MY_APP_VAR: "value" },
  onCrash: (err, ctx) => console.error("supervisor crash", ctx, err),
});

process.on("SIGTERM", () => handle.shutdown());
```

The PM worker script should `import { ProcessManager } from "@synapse-chat/server"` and translate IPC commands via `IpcProcessManager`. See `vibe-admiral/engine/src/supervisor.ts` for a reference implementation.

## Dependencies

- [`@synapse-chat/core`](../core) — shared types (`StreamMessage`, `ProcessManagerLike`, …)
- Node.js ≥ 20

## License

MIT
