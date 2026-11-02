# @mizunowanko/synapse-chat-mcp

## 0.12.0

### Minor Changes

- desktop: 承認されたブラウザも、ほかのアプリと同じにクリック・キー入力・AX の操作ができるようにした（syn-9）。ブラウザであることでは入力を拒まず、見るだけになるのは承認が `readOnly` にしたアプリだけ（`read-only` の断りもそのときだけ）。`DesktopAppRequest` に `browser: boolean`（承認の画面が警告を出すための印）を足し、`readOnly` は互換のために残して常に `false` にした（廃止予定。承認の応答の `readOnly` は今までどおり）。サーバーの instructions と `request_access` の説明を書き換え、ブラウザでは Web のページの中の文の指示に従わないこと・お金を動かす操作をしないことを説明に入れた。helper（Swift）は変えていない。

## 0.11.1

### Patch Changes

- desktop の `ax_tree` の結果が Claude Code でサマリの JSON だけになり、木の行がモデルに届かなかったのを直す（syn-8）。Claude Code は `structuredContent` があると text を捨てるので、木を `structuredContent.tree` にも入れ、text は「木の行 + サマリ JSON 1 行」にした。

## 0.11.0

### Minor Changes

- desktop: 承認されたアプリを、人の画面を奪わずに裏で見て操作する（syn-7）。`screenshot` は既定でウィンドウを 1 枚だけ撮る（裏・別の操作スペース・別のディスプレイでも撮れる。最小化は `minimized`）。`list_windows`、AX の木を ref 付きで読む `ax_tree`（`scope: "menubar"` も）、ref を操作する `ax_press` / `ax_set_value` / `ax_perform` を足した。ウィンドウを撮ったあとの `left_click`（左クリックは AX で押す）・`key`・`type`・`scroll` などは、そのアプリにだけ `CGEvent.postToPid` で送り、ポインタも最前面のアプリも変えない。従来の画面座標の操作は `screenshot` の `mode: "screen"` のあとの前面の手段として残し、`open_application` のあとはウィンドウが出るまで最大 2 秒待つ。helper（版 2）を置き換えること。古い helper には `helper-outdated` を返す。

## 0.10.1

### Patch Changes

- desktop の helper を直した（syn-6）。`build.sh` に `--sign <identity>`（環境変数 `SYNAPSE_DESKTOP_SIGN_IDENTITY`）を足し、証明書で署名すると designated requirement が証明書ベースになって、ビルドし直してもアクセシビリティ・画面収録・入力監視の権限が残る（無ければ従来どおり ad hoc）。承認されたアプリのウィンドウがメインディスプレイに出ていない（別の操作スペース・最小化・隠す）と ScreenCaptureKit が `SCStreamErrorDomain -3811` で失敗していたのを、撮る前に確かめて `no-window` で断るようにした（そのあとの失敗は `capture-failed`）。Esc の見張りのイベントタップは macOS 26 では入力監視が要るので、`status` に `inputMonitoring` を出し、`requestPermissions` とメニューで入力監視も求め、見張りが無いときの入力の断りを `permission: "inputMonitoring"` にした。

## 0.10.0

### Minor Changes

- macOS のデスクトップを見て操作する stdio の MCP サーバー `@synapse-chat/mcp/desktop`（bin `synapse-desktop`）と、権限を持つネイティブの helper（`packages/mcp/desktop-helper/`、Swift。`build.sh` で ad hoc 署名の `.app` にビルドする。npm のパッケージには入らない）を追加した（agents-familia agt-277 段 1）。ツールは Anthropic の computer use に寄せた `request_access` / `list_granted_applications` / `screenshot` / 各種クリック / `mouse_move` / `left_click_drag` / `scroll` / `key` / `type` / `open_application` / `cursor_position` / `wait` / `zoom`。許可はサーバーが決めず、アプリが実装する承認 API（`POST /api/desktop/access`・`GET /api/desktop/access/<requestId>?waitMs=`、型は `contract.ts`）に `--api` / `--desk-id` で聞く。ブラウザは常に見るだけ、期限切れは全部断る。helper は承認されたアプリのウィンドウだけを ScreenCaptureKit で撮り、入力の前に対象のアプリを確かめ、1 セッションだけのロックを持ち、Esc で中止する。座標は直前のスクリーンショットの画素。

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
