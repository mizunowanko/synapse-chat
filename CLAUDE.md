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
| インストール | `pnpm install` |
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
- リリースは Changesets で管理（`pnpm changeset` → `pnpm version` → `pnpm release`）

## vibe-admiral との関係

本リポは元々 [vibe-admiral](https://github.com/mizunowanko/vibe-admiral) の `synapse-chat/` サブディレクトリとして開発されていたが、独立 npm パッケージ化のため切り出された。vibe-admiral は現在 `@synapse-chat/*` を `file:../synapse-chat/packages/<name>` 参照で利用している（transitional）。将来的には npm 公開版に切り替わる予定。

ローカルで vibe-admiral と同時に扱う際は、両リポを `~/Projects/Application/` 以下に兄弟配置する:

```
~/Projects/Application/
  vibe-admiral/
  synapse-chat/   ← このリポ
```
