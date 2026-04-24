# @synapse-chat/mcp

MCP (Model Context Protocol) helpers for synapse-chat: turn an application's Backend HTTP API into a set of MCP tools that local CLI agents (Claude Code, Gemini CLI, …) can call directly.

## What's inside

| Export | Purpose |
| --- | --- |
| `defineHttpTool()` | Declarative description of a single Backend endpoint as an MCP tool. Validates name / method / path at authoring time. |
| `createMcpServer()` | Wire a set of tool definitions into an MCP stdio server in one call. Handles `tools/list` and `tools/call` requests against the MCP SDK. |
| `callHttpTool()` | Lower-level helper that substitutes path params, builds the request, and maps 4xx/5xx responses into MCP-shaped error results. |
| `prepareMcpWorkspace()` | Write the CLI-specific settings files (`.mcp.json` + `.claude/settings.local.json`, or `.gemini/settings.json`) to a worktree before spawning the CLI. |
| `generateGeminiSettings()` / `writeGeminiSettings()` | Pure / filesystem variants for Gemini CLI. |
| `generateClaudeSettings()` / `writeClaudeSettings()` | Pure / filesystem variants for Claude Code. |
| `deriveAllowedTools()` | Translate MCP tool definitions into a CLI allow-list (`mcp__<server>__<tool>` for Claude, `<server>__<tool>` for Gemini). |

## Quick look

```ts
// packages/backend/mcp-server.mjs
import { createMcpServer, defineHttpTool } from "@synapse-chat/mcp";

const tools = [
  defineHttpTool({
    name: "list_duties",
    description: "List every duty currently open.",
    method: "GET",
    path: "/api/duties",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" } },
    },
  }),
  defineHttpTool({
    name: "delete_duty",
    description: "Delete a duty. Destructive.",
    method: "DELETE",
    path: "/api/duties/{id}",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    confirmation: true,
  }),
];

const server = createMcpServer({
  name: "my-backend",
  version: "0.1.0",
  tools,
  baseUrl: process.env.BACKEND_BASE_URL,
});
await server.start();
```

```ts
// server.ts — spawn the CLI with the MCP server pre-wired
import { prepareMcpWorkspace } from "@synapse-chat/mcp";
import { spawn } from "node:child_process";

await prepareMcpWorkspace(worktreePath, {
  cli: "claude",
  mcpServers: {
    "my-backend": {
      command: "node",
      args: ["./mcp-server.mjs"],
      env: { BACKEND_BASE_URL: "http://localhost:8080" },
    },
  },
});

spawn("claude", ["-p", "List open duties"], { cwd: worktreePath });
```

See [`docs/mcp-helper-guide.md`](../../docs/mcp-helper-guide.md) for the full walkthrough.

## Design notes

- **Input schemas are JSON Schema.** No Zod / TypeBox lock-in. The MCP SDK accepts JSON Schema verbatim, and this keeps the door open for OpenAPI → MCP generation.
- **Confirmation is first-class.** `confirmation: true` automatically injects a required `confirmed: boolean` property into the tool's input schema and short-circuits with an MCP error if missing.
- **Generators merge, they do not clobber.** Existing `.mcp.json` / `.gemini/settings.json` contents are preserved; only the `mcpServers` map and enablement flags are touched.
- **Transport.** Stdio only for MVP. The server handle exposes the underlying `Server` so callers who need SSE / HTTP transports can call `server.connect(...)` with their own transport.
