# MCP Helper Guide

`@synapse-chat/mcp` turns an application's Backend HTTP API into MCP tools that local CLI agents (Claude Code, Gemini CLI) can call directly. It handles four things so each consumer does not reinvent them:

1. Declarative tool definitions (`defineHttpTool`).
2. An HTTP → MCP tool proxy (`createMcpServer`).
3. A standardised `confirmation` gate for destructive operations.
4. CLI settings-file generation (`.mcp.json`, `.claude/settings.local.json`, `.gemini/settings.json`) + derived allow-lists.

The package is optional — existing `@synapse-chat/server` consumers that only need `allowedTools` / `disallowedTools` continue to work unchanged.

## Why a helper?

Prior to this package, every app solved the same problem differently:

- **Managemaid** shipped a hand-rolled MCP stdio server and wrote `.gemini/settings.json` per worktree.
- **vibe-admiral** called its Engine via plain HTTP from inside CLI skills and relied on `--allowedTools` to keep the model on rails.
- New applications had no template to follow.

`@synapse-chat/mcp` lets every app describe tools declaratively and share one implementation for spawning + wiring.

## Anatomy of a tool

```ts
import { defineHttpTool } from "@synapse-chat/mcp";

export const listDuties = defineHttpTool({
  name: "list_duties",
  description: "List every open duty.",
  method: "GET",
  path: "/api/duties",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "done"] },
      limit: { type: "number" },
    },
  },
});

export const deleteDuty = defineHttpTool({
  name: "delete_duty",
  description: "Permanently delete a duty. Destructive.",
  method: "DELETE",
  path: "/api/duties/{id}",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  confirmation: true,
});
```

### What the helper does for you

- **Path placeholders**: `{id}` is extracted from the tool arguments at call time. Missing placeholders become an MCP error result so the LLM can recover.
- **Body vs. query**: `GET` / `HEAD` / `DELETE` serialise remaining args into a query string; `POST` / `PUT` / `PATCH` serialise them as JSON body with `content-type: application/json`.
- **Errors**: 4xx / 5xx responses are surfaced as `isError: true` tool results with `HTTP <status> <statusText>\n<body>`.
- **Confirmation**: when `confirmation: true`, a `confirmed: boolean` property is injected into the schema and marked required. If the LLM calls the tool without `confirmed=true`, the helper returns an error result (no HTTP request is issued).

## Running a server

```ts
// packages/backend/bin/mcp-server.mjs
#!/usr/bin/env node
import { createMcpServer } from "@synapse-chat/mcp";
import { listDuties, deleteDuty } from "../src/mcp/tools.js";

const server = createMcpServer({
  name: "my-backend",
  version: "0.1.0",
  tools: [listDuties, deleteDuty],
  baseUrl: process.env.BACKEND_BASE_URL,
  headers: {
    authorization: `Bearer ${process.env.BACKEND_TOKEN ?? ""}`,
  },
  onToolCall: ({ name, args }) => {
    console.error(`[mcp] ${name}`, args);
  },
});

await server.start();
```

Key points:

- `start()` connects a `StdioServerTransport`. Stdio is the MVP transport; custom transports can call `server.connect(transport)` on the exposed `Server` handle directly.
- Environment variables resolve at `start()` time — no module-load surprises.
- Only `node` + the MCP SDK are at runtime — the helper itself has no other runtime deps.

## Wiring it into a worktree

```ts
import { prepareMcpWorkspace } from "@synapse-chat/mcp";
import { spawn } from "node:child_process";

await prepareMcpWorkspace(worktreePath, {
  cli: "claude",
  mcpServers: {
    "my-backend": {
      command: "node",
      args: ["./bin/mcp-server.mjs"],
      env: {
        BACKEND_BASE_URL: "http://localhost:8080",
        BACKEND_TOKEN: process.env.BACKEND_TOKEN!,
      },
    },
  },
});

spawn("claude", ["-p", "List open duties"], { cwd: worktreePath });
```

For Claude Code this writes two files:

- `.mcp.json` — server spawn config.
- `.claude/settings.local.json` — sets `enableAllProjectMcpServers: true` and adds the server to `enabledMcpjsonServers` so Claude does not prompt for approval on every launch.

For `cli: "gemini"` a single `.gemini/settings.json` is written with the `mcpServers` section.

Both calls preserve any unrelated fields already present in the file — safe to run on a worktree that carries user settings.

## Composing with existing allowedTools

`@synapse-chat/server`'s `ProcessManager` passes `--allowedTools` verbatim. Derive the MCP names and merge:

```ts
import { deriveAllowedTools } from "@synapse-chat/mcp";

const mcpAllow = deriveAllowedTools({
  cli: "claude",
  servers: { "my-backend": [listDuties, deleteDuty] },
});
// → ["mcp__my-backend__list_duties", "mcp__my-backend__delete_duty"]

const allowedTools = ["Read", "Glob", "Grep", ...mcpAllow];
pm.dispatchSortie(id, cwd, prompt, "investigate");
// or use your own spawner that respects `allowedTools`.
```

`deriveAllowedTools` emits the correct format for each CLI (`mcp__<server>__<tool>` for Claude, `<server>__<tool>` for Gemini).

## Adapter integration (optional)

`CLIAdapter` exposes an optional `prepareWorkspace?(cwd): Promise<void>` hook. Custom spawners that want a uniform pre-spawn step can wrap an adapter with MCP setup:

```ts
import type { CLIAdapter } from "@synapse-chat/core";
import { prepareMcpWorkspace, type McpServersConfig } from "@synapse-chat/mcp";

export function withMcp(
  adapter: CLIAdapter,
  opts: { cli: "claude" | "gemini"; mcpServers: McpServersConfig },
): CLIAdapter {
  return {
    ...adapter,
    async prepareWorkspace(cwd: string) {
      await prepareMcpWorkspace(cwd, opts);
    },
  };
}
```

The built-in `ProcessManager` does not invoke this hook itself — it is purely declarative metadata for custom spawners.

## Testing tips

- **Tools**: exercise `callHttpTool` with a fake `fetch` (see `http-client.test.ts` in this package).
- **Server**: use `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js` to drive the server in-process, as done in `create-mcp-server.test.ts`.
- **Generators**: write to a `mkdtemp` directory and assert file contents.

## FAQ

**Is the MCP SDK required at runtime?** Yes — `@modelcontextprotocol/sdk` is a direct dependency of `@synapse-chat/mcp`. Callers who never import from this package never pull it in.

**Can I bring my own Zod?** Yes — generate a JSON Schema from Zod (e.g., `zod-to-json-schema`) and pass that as `inputSchema`. The helper does not run validation; the MCP SDK does.

**When should I migrate from stub-cli / plain HTTP?** When you want the LLM to see tools as first-class function calls instead of mediating through Bash heuristics. There is no hard rule — both styles coexist.
