---
"@synapse-chat/mcp": minor
"@synapse-chat/core": minor
---

feat: add `@synapse-chat/mcp` — declarative MCP tool proxies + CLI settings generators

- New package `@synapse-chat/mcp` exposes a small surface for turning an application's Backend HTTP API into MCP tools that local CLI agents (Claude Code, Gemini CLI) can call directly.
- `defineHttpTool({ name, method, path, inputSchema, confirmation? })` authoring helper with build-time validation.
- `createMcpServer({ name, version, tools, baseUrl })` wires a set of tools into an MCP stdio server in one call (exposes the underlying `Server` handle so callers can attach custom transports / additional handlers).
- `callHttpTool()` lower-level helper: substitutes `{placeholder}` path params, serialises remaining args as query (GET/HEAD/DELETE) or JSON body (POST/PUT/PATCH), maps 4xx/5xx responses to MCP `isError` tool results.
- Standardised `confirmation: true` guard for destructive actions: the helper auto-injects `confirmed: boolean` into the input schema and short-circuits with an MCP error if the LLM invokes the tool without explicit confirmation.
- Settings-file generators for Claude Code (`.mcp.json` + `.claude/settings.local.json`) and Gemini CLI (`.gemini/settings.json`). `prepareMcpWorkspace(cwd, { cli, mcpServers })` merges into existing files so user settings are preserved.
- `deriveAllowedTools({ cli, servers })` produces CLI-specific allow-list entries (`mcp__<server>__<tool>` for Claude, `<server>__<tool>` for Gemini). Fully compatible with the existing `allowedTools` / `disallowedTools` flow in `@synapse-chat/server`.
- `@synapse-chat/core` gains an optional `prepareWorkspace?(cwd): Promise<void>` hook on `CLIAdapter` so custom spawners can surface a uniform pre-spawn step. The built-in `ProcessManager` is unchanged; existing adapters keep working without modification.
