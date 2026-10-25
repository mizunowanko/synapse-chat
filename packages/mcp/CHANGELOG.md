# @mizunowanko/synapse-chat-mcp

## 0.9.0

### Minor Changes

- MCP サーバーの台帳の行に「UI を持つ」（MCP App）の印 `ui` を足す。`put` の JSON の `"ui": true` か `put --ui` で書き、`McpServerRecord.ui`・`McpServerStore.listApps()`・`list --ui` で読む。列を足すだけで、スキーマの版は 1 のまま（旧い版も同じファイルを開ける）。起動時の渡し方は変わらない（agents-familia agt-224）

## 0.8.0

### Minor Changes

- スキル・MCP サーバーの台帳の Desk の階層を、Desk の id で引けるようにした（agt-215）。`SkillsLaunchOptions.deskId`・`deskViewer()`・CLI の `--desk-id`（`synapse-skills` / `synapse-mcp-servers` / `synapse-instructions launch`）。id を渡すとき、Desk の名前（`desk` / `--desk`）は、名前を鍵にした旧い行を id の下で読むための旧い鍵（`legacyDesk`）になる（読むだけ。書き込みは id へ）。`--desk` だけの呼び出しはいままでどおり、その値を鍵にする。

## 0.7.0

### Minor Changes

- CLI のセッションから同じアプリのほかのセッションにメッセージを送る stdio の MCP サーバー `@synapse-chat/mcp/peers`（bin `synapse-peers`）を追加した（syn-4）。ツールは `list_peers` / `send_message` で、中身はアプリが実装する 2 つの HTTP の受け口（`GET /api/peers`・`POST /api/peers/messages`、型は `contract.ts`）への薄い中継。送り手はサーバーの起動引数のトークン（`Authorization: Bearer`）でアプリが決める（環境変数では受けない）。アプリの断り（`reason` と添えたもの）はそのままモデルに渡し、自分で作るのは `server-unreachable`（繋がらない・形が違う・時間切れ）だけ。Claude Code（`claudePeersMcpServers`）/ Codex（`codexPeersConfigArgs`）/ agy（専用の plugin `synapse-peers`、`agyPeersPluginFiles`・`withdrawPeersFiles`）への登録の形を返す。MCP サーバーの台帳では `peers` を予約にした。

## 0.6.0

### Minor Changes

- エージェントが使う MCP サーバーの台帳を、スキル・指示書と同じ SQLite に 3 階層（全員・エージェント・Desk）で持ち、起動時に Claude Code / Codex / agy それぞれの形で渡す `@synapse-chat/mcp/mcp-servers` と、管理用 CLI `synapse-mcp-servers`（list / show / put / rm / history / launch）を追加した（syn-3）。1 件は名前・transport（stdio: command・args・env・cwd／http: url・headers）・有効かどうか。秘密は `${NAME}` で環境変数を参照し、起動時に展開する（無ければそのサーバーを渡さず `skipped` に出す）。Claude は `mcpServers`（呼ぶ側が自分の server と 1 つの `--mcp-config` にまとめる。stdio の `cwd` は `/bin/sh` を挟んで効かせる）、Codex は `-c mcp_servers.<name>.…`（TOML を正しく escape）、agy は workspace plugin。`synapse-instructions launch` の出力にも `mcp` として入り、`--desk` を受け付ける。

## 0.5.1

## 0.5.0

## 0.4.0

### Minor Changes

- 指示書を SQLite（スキルと同じファイル）に 2 階層（全員・エージェント）で置き、起動時に Claude Code / Codex / agy へ常に文脈に入る形で渡す `@synapse-chat/mcp/instructions` と、管理用 CLI `synapse-instructions` を追加した（agents-familia-43）。置き換える指示ファイルは Claude では `claudeMdExcludes`、Codex では `project_doc_max_bytes=0` で読ませない。agy は止められないので `stillLoaded` で知らせる。

## 0.3.0

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
