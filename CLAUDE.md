# synapse-chat

AI CLI チャットフレームワーク。ローカル AI CLI（Claude Code / Gemini CLI など）を WebSocket 経由でブラウザチャット UI に接続するための "のり" となるパッケージ群。

詳細は [README.md](README.md) を参照。

## リポ構成

pnpm workspaces の monorepo。

```
packages/
  core/     @synapse-chat/core    — 共通型・インターフェース（StreamMessage, CLIAdapter 等）
  react/    @synapse-chat/react   — React UI プリミティブ + WS クライアント + useChat hook
  server/   @synapse-chat/server  — Node.js プロセスマネージャ + ストリームパーサ + supervisor
apps/
  example/  @synapse-chat/example — Vite + React + ws の動作サンプル（非公開）
docs/       プロトコル仕様・Adapter ガイド
.changeset/ Changesets 管理
```

## コマンド

| 目的 | コマンド |
|------|----------|
| インストール | `env -u npm_config_exclude_links_from_lockfile NODE_ENV=development pnpm install --config.confirmModulesPurge=false`（下の注記） |
| 全パッケージビルド | `pnpm build` |
| 型チェック | `pnpm typecheck` |
| テスト実行 | `pnpm test` |
| Lint | `pnpm lint` |
| API docs 生成 | `pnpm docs:api` |
| Example アプリ起動 | `pnpm --filter @synapse-chat/example dev` |

## 開発規約

- コミット prefix: `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`
- ブランチ: `feature/<issue-num>-<short-name>`
- ESM 固定（`"type": "module"`）、Node 20+
- TypeScript ~5.7 を全 package で共有（`tsconfig.base.json`）
- リリースは Changesets で管理。**版上げは PR の中で済ませる**（下の「リリース」）

## リリース（#68）

**GitHub Packages に `@mizunowanko/synapse-chat-{core,react,server,mcp}` として出る。** GitHub Packages は scope がオーナー名と一致しないと受け付けないので、名前だけが変わる。**import は `@synapse-chat/*` のまま**で、アプリは npm alias で受ける（`"@synapse-chat/core": "npm:@mizunowanko/synapse-chat-core@0.1.0"`）。repo の中でも、パッケージ間の依存は `workspace:@mizunowanko/synapse-chat-core@*` という alias で書いてあり、`pnpm publish` が `npm:…@<版>` に書き換えて出す。

| | |
|---|---|
| **版** | 4 パッケージで**同じ版**（`.changeset/config.json` の `fixed`）。アプリは全部を同じ版に固定すればよく、core の型が 2 つ入ることもない |
| **版上げ** | **PR の中で** `pnpm changeset` → `pnpm version` まで済ませて、`package.json` / `CHANGELOG.md` の変更ごと commit する。未適用の changeset が残った PR は CI が落とす |
| **publish** | main に入ると `.github/workflows/release.yml` が `pnpm release`（build + `changeset publish`）を回し、registry に無い版だけを出して、タグ（`@mizunowanko/synapse-chat-core@0.1.0` …）を push する。手で `pnpm release` しない |
| **CI** | `.github/workflows/ci.yml`。react のテストだけは #52（`React.act is not a function`）が直るまで `continue-on-error` |

Actions に「Version Packages」の PR を作らせる changesets/action の流れは使っていない（この repo は Actions に PR を作らせない設定）。

### アプリ（agents-familia / Vistudy）と同時に直すとき

**synapse を先にリリースし、アプリ側で版を上げる。** 手元の synapse をアプリに差し込む仕組み（`pnpm link`、`file:`、`link:`、node_modules の張り替え）は**用意していないし、使わない。**

1. synapse の worktree で直す。テストは synapse の中で書く（アプリの症状は、synapse のテストで再現させる）
2. 同じ PR で `pnpm changeset` → `pnpm version`。マージすると数分で publish される
3. 出たことを確かめる: `gh api /users/mizunowanko/packages/npm/synapse-chat-core/versions --jq '.[0].name'`
4. アプリの worktree で `@synapse-chat/*` の alias の版を**全部**同じ版に上げ、`NODE_AUTH_TOKEN=$(gh auth token)` を付けて install。lockfile ごと commit する

アプリ側を先に書き始めてよいが、マージは synapse のリリースを待つ。手元で差し込むと、**差し込んだままの `package.json` / lockfile が commit される**事故と、React が 2 つ入る事故がついてくる。1 往復数分のリリースのほうが安い。

### install の注記

agents-familia から起動したシェルには、昔の設定の名残で `npm_config_exclude_links_from_lockfile` が入っていることがある。そのまま `pnpm install` すると、この repo の lockfile に `excludeLinksFromLockfile: true` が焼き込まれ、CI の `--frozen-lockfile` が落ちる。`env -u` で落としてから走らせる。

## vibe-admiral との関係

本リポは元々 [vibe-admiral](https://github.com/mizunowanko/vibe-admiral) の `synapse-chat/` サブディレクトリとして開発されていたが、独立 npm パッケージ化のため切り出された。vibe-admiral は現在 `@synapse-chat/*` を `file:../synapse-chat/packages/<name>` 参照で利用している（transitional）。将来的には npm 公開版に切り替わる予定。

ローカルで vibe-admiral と同時に扱う際は、両リポを `~/Projects/Application/` 以下に兄弟配置する:

```
~/Projects/Application/
  vibe-admiral/
  synapse-chat/   ← このリポ
```
