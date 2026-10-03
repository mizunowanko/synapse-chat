# @mizunowanko/synapse-chat-mcp

## 0.2.0

### Minor Changes

- スキルを SQLite に入れて stdio MCP で配る `@synapse-chat/mcp/skills` と、管理用 CLI `synapse-skills` を追加（#73）。階層（全員 → エージェント → Desk）、版と削除の印、付属ファイルの書き出し（`~/.cache/synapse-skills/<skill>@<版>/`）、`list_skills` / `get_skill` / `put_skill`、Claude Code / Codex / agy への登録の生成。Node 22.13 以上（`node:sqlite`）。

## 0.1.0

### Minor Changes

- ad44d85: feat: add `@synapse-chat/mcp` — declarative MCP tool proxies + CLI settings generators

  - New package `@synapse-chat/mcp` exposes a small surface for turning an application's Backend HTTP API into MCP tools that local CLI agents (Claude Code, Gemini CLI) can call directly.
  - `defineHttpTool({ name, method, path, inputSchema, confirmation? })` authoring helper with build-time validation.
  - `createMcpServer({ name, version, tools, baseUrl })` wires a set of tools into an MCP stdio server in one call (exposes the underlying `Server` handle so callers can attach custom transports / additional handlers).
  - `callHttpTool()` lower-level helper: substitutes `{placeholder}` path params, serialises remaining args as query (GET/HEAD/DELETE) or JSON body (POST/PUT/PATCH), maps 4xx/5xx responses to MCP `isError` tool results.
  - Standardised `confirmation: true` guard for destructive actions: the helper auto-injects `confirmed: boolean` into the input schema and short-circuits with an MCP error if the LLM invokes the tool without explicit confirmation.
  - Settings-file generators for Claude Code (`.mcp.json` + `.claude/settings.local.json`) and Gemini CLI (`.gemini/settings.json`). `prepareMcpWorkspace(cwd, { cli, mcpServers })` merges into existing files so user settings are preserved.
  - `deriveAllowedTools({ cli, servers })` produces CLI-specific allow-list entries (`mcp__<server>__<tool>` for Claude, `<server>__<tool>` for Gemini). Fully compatible with the existing `allowedTools` / `disallowedTools` flow in `@synapse-chat/server`.
  - `@synapse-chat/core` gains an optional `prepareWorkspace?(cwd): Promise<void>` hook on `CLIAdapter` so custom spawners can surface a uniform pre-spawn step. The built-in `ProcessManager` is unchanged; existing adapters keep working without modification.

- 7057736: First release, published to GitHub Packages (#68)

  The packages are published as `@mizunowanko/synapse-chat-{core,react,server,mcp}`
  because GitHub Packages requires the npm scope to match the repository owner.
  Import paths do not change: consumers install them under the old names through an
  npm alias, e.g. `"@synapse-chat/core": "npm:@mizunowanko/synapse-chat-core@0.1.0"`.
  All four packages share one version.
