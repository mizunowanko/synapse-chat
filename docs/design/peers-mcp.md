# セッション間のメッセージを MCP で中継する（peers）

CLI のセッションから、同じアプリのほかのセッションにメッセージを送るための **stdio の MCP サーバー**。Claude Code / Codex / agy のどれにも同じサーバーを登録する。中身は、アプリが実装する 2 つの HTTP の受け口への**薄い中継**で、宛先の意味・届け方・歯止めはアプリが持つ。

実装は `@synapse-chat/mcp/peers`（[`packages/mcp/src/peers/`](../../packages/mcp/src/peers/)）と、同じパッケージの bin `synapse-peers`。最初の使い手は agents-familia の Desk 間のメッセージ（syn-4。familia の `docs/design/peer-messages.md`）。

| 部品 | ファイル | |
|---|---|---|
| HTTP の取り決め | `contract.ts` | リクエストと応答の型、断るときの `reason` のコード |
| HTTP の呼び出し | `client.ts` | `createPeersClient()`。失敗を全部 `PeerRefusal` にする |
| MCP サーバー | `server.ts` | `list_peers` / `send_message`、instructions、annotations |
| 各 CLI への登録 | `registration.ts` | 設定の中身を返すだけ。書かない |
| bin | `cli.ts` | `synapse-peers serve / register` |

`node:sqlite` を使わない（状態を持たない）ので、Node 20 でも動く。

## 層の分け方

| どこ | 持つもの |
|---|---|
| synapse-chat（ここ） | MCP サーバー、取り決めの型、各 CLI への登録の形、annotations、CLI ごとの罠 |
| アプリ | 送り手の名乗り（トークンの発行と引き当て）、宛先の解決、届け方（止まっているセッションを起こす・ターンの終わりを待つ）、歯止め、記録、受け手に届く文面 |

このサーバーは宛先・状態・断りの理由を**解釈しない**。アプリが返したものをそのままモデルに渡し、自分で作るのは `server-unreachable` だけ。ツールの説明と instructions にもアプリの語（Desk、Escalation など）を入れない。ほかのアプリが自分の宛先の体系で使えるように。

## HTTP の取り決め

| | |
|---|---|
| `GET {api}/api/peers` | → 200 `{ self, peers }`（`PeersListResponse`） |
| `POST {api}/api/peers/messages` | `{ to, message }` → 200 `{ id, to, status, woke }`（`SendPeerMessageResponse`） |

- 両方とも `Authorization: Bearer <token>`。**トークンが送り手を決める。** 本文に送り手は書かない
- POST は `Content-Type: application/json`
- **`Origin` を付けない。** アプリはブラウザ（ページ・アプレット・MCP Apps のカード）からのリクエストを `Origin` で見分けて断る。`fetch` の実装が勝手にヘッダを足すことを当てにしないよう、`node:http` / `node:https` で送る
- `{api}` にパスがあれば保つ（`http://host/prefix` → `http://host/prefix/api/peers`）。query と fragment は拒否

`list_peers` の 1 件:

| フィールド | 値 |
|---|---|
| `address` | 送るときの宛先 |
| `agent` / `displayName` / `desk` | 相手の名前 |
| `provider` | 相手のいまの CLI（`claude` / `codex` / `gemini`。アプリが足してもよい） |
| `state` | `idle` / `working` / `stopped`（止まっていても送れる。届け方はアプリが決める） |
| `self` | 自分の行 |

`send_message` の `status` は `delivered`（相手のセッションに書き込んだ）か `queued`（相手がターン中で、終わったらアプリが書き込む）。`woke: true` は、止まっていた相手をアプリが起こしてから書き込んだこと。

### 断るとき

アプリは 4xx / 5xx と `{ error, reason, … }` を返す。サーバーはそれを**全部そのまま** `isError: true` の結果に入れる（`structuredContent` に同じもの、テキストは 1 行目に `<tool> failed (<reason>): <error>`、続けて JSON）。

| `reason` | HTTP | 添えるもの |
|---|---|---|
| `unauthorized` | 401 | — |
| `origin-refused` | 403 | — |
| `bad-request` | 400（415・405） | — |
| `too-long` | 413 | `limit` |
| `unknown-address` | 404 | `candidates` |
| `self` | 400 | — |
| `not-reachable` | 409・503 | `detail` |
| `chain-limit` | 409 | `depth`、`limit` |
| `rate-limited` | 429 | `retryAfterSeconds`、`scope`（`pair` / `sender`） |
| `wake-failed` | 502 | `detail` |
| **`server-unreachable`** | —（サーバーが作る） | `detail`: 接続のエラーコード（`ECONNREFUSED` など）/ `timeout` / `bad-response: HTTP <n>` |

- 知らない `reason` も、そのまま渡す（アプリが新しいコードを足しても壊れない）
- `reason` の無いエラーの応答、JSON でない応答、形の合わない 200 は `server-unreachable`（`bad-response`）
- 引数が空（`to` / `message` が無い・空白だけ）なら、アプリに送らずに `bad-request` で返す
- **時間切れ**（既定 45 秒、`--timeout-ms`）は `server-unreachable`（`timeout`）。POST では「届いたかどうか分からない。送り直す前に確かめる」と書く。45 秒は Codex の MCP ツールの時間の上限（既定 60 秒）より短くしてあり、CLI に切られる前にこちらの答えを返す

## ツール

| ツール | annotations | |
|---|---|---|
| `list_peers` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` | 引数なし |
| `send_message` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false` | `to`・`message`（必須。上限はアプリが決める） |

- `send_message` の annotations は、非対話の `codex exec`（approval policy が never）が承認待ちで落とさないため（スキルの `put_skill` と同じ。[skills-mcp.md](skills-mcp.md)）
- instructions（`initialize` の応答）は「宛先は `list_peers` の `address`」「返事は自分の会話に届くのでポーリングしない」「礼や『了解』だけの返信はしない」。**Codex には instructions が届かない**ので、アプリは受け手に届く文面にツール名と宛先を書く（familia は書いている）

## 誰として送るか（起動引数）

```
node …/dist/peers/cli.js serve --api http://127.0.0.1:8001 --token <t> [--log /abs/peers.jsonl] [--timeout-ms 45000]
```

**トークンと URL は起動引数だけで受ける。環境変数では受けない**（[skills-mcp.md](skills-mcp.md)「どのエージェントか」と同じ理由。環境変数は子プロセスに黙って引き継がれ、セッションが起動した別の CLI も同じ名乗りになる）。

トークンは、登録の関数が返すものすべて（Claude の `--mcp-config` の JSON、Codex の `-c`、agy の plugin のファイル）に入る。

- **起動のログに引数をそのまま出さない**のは呼ぶ側の責任（familia の `redactLaunchArgs` は `--mcp-config` と `mcp_servers.<name>.` を伏せる）
- **agy の plugin のファイルにトークンが入る。** 持ち主だけが読める権限（`0600`）で書き、git に入れない（`synapse-peers register agy --out` は `0600` で書く。登録の関数は中身を返すだけなので、書く側が決める）
- `ps` でほかのプロセスの引数は読める。事故を防ぐ線で、悪意への防御ではない
- `serve` の失敗の文に引数を出さない（トークンを含むため）

`--log` の JSONL には `initialized` / `tools/list` / `tools/call` を残す。`send_message` は宛先・本文の長さ・結果（`id`・`status`・`woke`、または `reason`・HTTP の status）だけで、**本文とトークンは書かない**。

## 各 CLI への登録

ユーザーの全体設定（`~/.claude`・`~/.codex`・`~/.gemini`）には書かない。

| CLI | 登録 | 関数 |
|---|---|---|
| Claude Code | `{ peers: entry }` を自分の server と合わせて 1 つの `--mcp-config` に（`claudeMcpConfigArgs`、[mcp-servers.md](mcp-servers.md)） | `claudePeersMcpServers()`（単独なら `claudePeersMcpConfig()`） |
| Codex | `-c mcp_servers.peers.command=…` `-c mcp_servers.peers.args=[…]` | `codexPeersConfigArgs()` |
| agy | ワークスペースに `.agents/plugins/synapse-peers/{plugin.json,mcp_config.json}` | `agyPeersPluginFiles()` |
| 取り下げ | agy: サーバーを 1 つも挙げない plugin を、**既にあるファイルにだけ**上書き。ほかは何も残らない | `withdrawPeersFiles(cli)` |

- サーバーの名前は `peers`（Claude では `mcp__peers__send_message`）。台帳（[mcp-servers.md](mcp-servers.md)）では `peers` は予約で、同じ名前の server は渡らない
- agy の plugin は専用（`synapse-peers`）。台帳の `synapse-mcp-servers`・スキルの `synapse-skills` と重ならない
- `command` は既定で**いま動いている Node の絶対パス**（`process.execPath`）。登録はセッションを起動するたびに作り直す前提

```ts
import { claudeMcpConfigArgs } from "@synapse-chat/mcp/mcp-servers";
import { claudePeersMcpServers, codexPeersConfigArgs, agyPeersPluginFiles } from "@synapse-chat/mcp/peers";

const peers = { api: "http://127.0.0.1:8001", token };          // トークンはセッションごと
// Claude: claudeMcpConfigArgs(claudePeersMcpServers(peers), mySkills, ledger.mcpServers)
// Codex:  [...codexPeersConfigArgs(peers), ...]
// agy:    { ...agyPeersPluginFiles(peers), ... } を cwd の下に（0600）
```

## 実測（2026-10-18、偽の受け口に向けて）

| CLI | 版 | 結果 |
|---|---|---|
| Claude Code | 2.1.296 | `-p --mcp-config … --strict-mcp-config --allowedTools mcp__peers__list_peers,mcp__peers__send_message` で、`list_peers` → `send_message`（delivered）→ 知らない宛先（`unknown-address` と `candidates` がモデルに届く）。サーバーの cwd はセッションの cwd |
| Codex（app-server） | 0.163.0 | familia と同じ `app-server --stdio`・`approvalPolicy: "never"`・`sandbox: "danger-full-access"` で、2 つとも承認の要求なしに呼べた。**対照として annotations を外したサーバーでも通った**（この組み合わせでは annotations は効いていない。`codex exec` の既定では効く — スキルの実測） |
| agy | 1.4.2 | `--dangerously-skip-permissions` 付きで 2 つとも呼べた。サーバーの cwd は plugin のディレクトリ（`…/.agents/plugins/synapse-peers`）で、絶対パスの `--log` が効いた。`0600` の `mcp_config.json` も読めた |

受け口に届いたリクエストは、GET が `accept`・`authorization`・`host`・`connection`、POST はそれに `content-type: application/json`・`content-length`。`Origin` は無い。

## 罠

- **agy は MCP のツールを、`--dangerously-skip-permissions` が無いと非対話で必ず断る**（`denied_actions: [{ action: "mcp" }]`。annotations は関係ない）。agy に渡すなら、許可を飛ばす起動にするか、ワークスペースの `settings.json` に `permissions.allow` の `mcp(…)` を置く
- **同じ cwd で agy を続けて起動すると、先のセッションが後のトークンを使う。** agy が plugin を読んでサーバーを起動するのは、起動から約 4 秒後（1.4.2 で実測）。その前に次の起動が plugin を書き換えると、先の agy も書き換えた後のトークンでサーバーを起動する（0.5 秒差で起動した 2 つが、両方とも後のトークンで送った）。plugin の名前を分けても、agy はディレクトリの plugin を全部読むので解決しない。同じ cwd の agy の起動は、前の agy のサーバーが起動するまで（`--log` の `initialized`）待たせるなど、呼ぶ側で直列にする
- **Codex は MCP の instructions をモデルに渡さず、MCP のツールを `tool_search` の奥に隠す。** 受け手に届く文面と指示書でツール名を教える
- **`codex exec` は stdin が開いていると待ち続ける。** 非対話で回すときは `< /dev/null`

## 確かめ方

単体テスト（`server.test.ts`、`registration.test.ts`）は、`127.0.0.1` に立てた偽の受け口に対して、送ったヘッダと本文、断りの写し方（全 `reason`）、`server-unreachable`（繋がらない・形が違う・時間切れ）、annotations、ログに本文とトークンが出ないことを見る。

本物の CLI では、`synapse-peers register <cli> --api http://127.0.0.1:<port> --token <t> --log /abs/peers.jsonl` で登録を作り、偽の受け口に向けて「`list_peers` を呼んで、`<宛先>` に送って」と頼む。`--log` の JSONL と、受け口が受けたリクエストで判定する。
