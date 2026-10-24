# MCP サーバーの台帳を SQLite に持ち、起動時に各 CLI の形で渡す

エージェントが使う MCP サーバーを、スキル・指示書と同じ **SQLite のファイル**に、**プロバイダに依らない形**で持つ。CLI を起動するときに、Claude Code・Codex・agy それぞれの渡し方に変える。アプリは「どの DB の、どのエージェント・Desk の台帳を、どの CLI に渡すか」だけを決める。プロバイダごとの作法（フラグ名、設定キー、置くファイル、cwd の扱い）はここが持つ。

実装は `@synapse-chat/mcp/mcp-servers`（[`packages/mcp/src/mcp-servers/`](../../packages/mcp/src/mcp-servers/)）と、同じパッケージの bin `synapse-mcp-servers`。

| 部品 | ファイル | |
|---|---|---|
| 1 件の形 | `config.ts` | 検査（`parseMcpServerSpec` / `parseMcpServerConfig`）と、環境変数の参照の展開（`expandMcpServerConfig`） |
| 置き場所 | `store.ts` | `McpServerStore`。スキルと同じ SQLite ファイルの `mcp_server_versions` テーブル |
| 起動時の渡し方 | `launch.ts` | `mcpServersLaunch()` / `claudeMcpConfigArgs()` / `withdrawMcpServersFiles()`。値を返すだけで、ファイルは書かない |
| 管理用 CLI | `cli.ts` | `synapse-mcp-servers list / show / put / rm / history / launch` |

きっかけは、エージェントごとの stdio の MCP（cwd の `.mcp.json`）が Claude の Desk でしか効かず、Codex の Desk が同じサーバーを使えなかったこと（syn-3）。台帳に 1 回書けば、どの CLI にも同じサーバーが渡る。

## 1 件の形

```json
{
  "name": "artiflow",
  "enabled": true,
  "transport": "stdio",
  "command": "/usr/local/bin/node",
  "args": ["/srv/artiflow/mcp.js"],
  "env": { "ARTIFLOW_TOKEN": "${ARTIFLOW_TOKEN}" },
  "cwd": "/srv/artiflow"
}
```

```json
{
  "name": "yatagarasu",
  "transport": "http",
  "url": "http://localhost:8790/${YATAGARASU_PASS}/mcp",
  "headers": { "Authorization": "Bearer ${YATAGARASU_TOKEN}" }
}
```

| キー | | |
|---|---|---|
| `name` | 必須 | 英数字で始まり、英数字・`-`・`_` だけ（`__` は不可）、64 文字まで。Claude のツール名 `mcp__<name>__<tool>` と Codex の TOML のキーにそのまま入るため。**`skills` と `peers` は使えない**（このパッケージが自分で渡す server の名前。[skills-mcp.md](skills-mcp.md)、[peers-mcp.md](peers-mcp.md)） |
| `enabled` | 既定 `true` | `false` の版は起動時に渡さない（下の「階層」） |
| `transport` | 必須 | `stdio` か `http`（Streamable HTTP）。旧い HTTP+SSE は扱わない |
| `command` / `args` / `env` / `cwd` | stdio | `cwd` は絶対パス。`env` のキーは環境変数の名前の形 |
| `url` / `headers` | http | `url` は http(s)。header の値に改行は入れられない |

- 知らないキーは書き込みのときに断る（綴りの誤りを黙って捨てない）
- 保存の前に正規化する（キーの順を固定し、空の `args` / `env` / `headers` は落とす）。中身が同じなら版を作らない

## 秘密の扱い

**秘密は DB に平文で入れない。** 文字列の値の中に `${NAME}` と書くと、**起動のとき**に呼ぶ側が渡す環境（既定は `process.env`）から展開する。

- 展開するのは `command`・`args`・`env` の値・`cwd`・`url`・`headers` の値。`name` と `env` / `headers` のキーは展開しない
- `NAME` は `[A-Za-z_][A-Za-z0-9_]*`。`${}` や閉じていない `${` は書き込みのときに断る。`$${` は文字どおりの `${` になる。`$NAME`（波括弧なし）は展開しない
- **参照先が無いときは、そのサーバーを渡さない。** 結果の `skipped` に「環境変数が無い: NAME」と名前だけを出す（空で展開して壊れた設定を渡さない）。空文字の変数は「ある」とみなす
- 展開したあとの値も検査する（`cwd` が絶対パスか、`url` が http(s) か、header に改行が無いか）。だめなら同じく `skipped` に理由を出す。**理由の文に値は入れない**（秘密を含みうる）
- 管理用 CLI の `put` は、`env` / `headers` のうち名前が秘密らしい（token・secret・key・password・auth など）のに `${…}` を使っていない値を見つけたら、stderr に警告する。断りはしない
- 展開した値は CLI の引数（Claude の `--mcp-config`、Codex の `-c`）や agy の plugin のファイルに入る。**起動のログに引数をそのまま出さない**のは呼ぶ側の責任（familia は `redactLaunchArgs` で `mcp_servers.<name>.<key>=` と `--mcp-config` を伏せている）

## 階層

**スキルと同じ 3 つ: 全員 → エージェント → Desk。同じ名前なら下の階層が勝つ。** キーもスキルと同じ（`agent: ""` が全員、`desk: ""` は Desk でない）。Desk の階層の鍵は **Desk の id**（agt-215）で、Desk の名前を鍵にした旧い行は、閲覧者の `legacyDesk`（Desk の名前）として id の下で読む（[skills-mcp.md「Desk の階層の鍵は Desk の id」](skills-mcp.md#desk-の階層の鍵は-desk-の-idagt-215)）。

- 勝った版が `enabled: false` なら、その閲覧者には渡さない（`effective().disabled` に入り、起動の結果の `disabled` に名前が出る）。全員の階層のサーバーを、あるエージェントや Desk だけで止められる
- **下の階層の削除の印（tombstone）は上を隠さない。** 上書きを消すと、上の階層のものが見えるようになる（スキルと同じ）

## 版と削除

スキルと同じ規則にそろえた。

- **書き込みは毎回、新しい行。** 既存の版は書き換えない。中身（設定と `enabled`）が最新版と同じなら版を作らない
- **版の番号は名前ごと**（階層をまたいで通し番号）。`history <name>` は全階層の版を古い順に出す
- **削除は印の行を足すだけ。** 前の版は残る。同じ階層にまた書けば、版は続きから

## 置き場所

**スキル・指示書と同じファイル**（`--db`、`$SYNAPSE_SKILLS_DB`、既定 `~/.local/share/synapse-skills/skills.db`）の別のテーブル。スキーマの版は `meta` の別のキー（`mcp_servers_schema_version`）で持つので、台帳を知らない古い版の `SkillStore` / `InstructionStore` も同じファイルをそのまま開ける。WAL・`busy_timeout = 5000`・採番は `BEGIN IMMEDIATE` の中、も同じ。

## 書き込みの権限

**書けるのは管理用 CLI だけ**（`synapse-mcp-servers put` / `rm`）。書き込む階層は `--global` か `--agent <名前>`（Desk なら `--desk-id <Desk の id>`。旧いアプリは `--desk <名前>`）で必ず名指しする。MCP から台帳を書く道は無い（任意のコマンドを起動させられるため）。

## 起動時の渡し方（`mcpServersLaunch`）

入力は、閲覧者（エージェント・Desk）について解決した台帳（`McpServerStore.effective(viewer)`）と、展開に使う環境、呼ぶ側が自分で渡す名前（`reserved`）。返すのは次のもの。

| 返り値 | 中身 |
|---|---|
| `mcpServers` | **Claude**: `--mcp-config` に入れる `mcpServers` のエントリ。ほかの CLI では `{}` |
| `args` | **Codex**: `-c mcp_servers.<name>.<key>=<TOML>` の並び。ほかの CLI では `[]` |
| `files` | **agy**: 起動の前に cwd の下へ書く workspace plugin（`相対パス → 中身`）。ほかの CLI では `{}` |
| `delivered` | 渡した名前 |
| `disabled` | 台帳で止めてある名前（渡していない） |
| `skipped` | 渡せなかった名前と理由（環境変数が無い、展開した値が使えない、`reserved`、TOML にできない） |

| CLI | 渡し方 | cwd |
|---|---|---|
| Claude Code | `mcpServers` を呼ぶ側が自分の server と合わせて 1 つの `--mcp-config` にする（`claudeMcpConfigArgs`） | **Claude は stdio の `cwd` を無視する**（2.1.296 で実測）。`/bin/sh -c 'cd -- "$1" && shift && exec "$@"'` を挟んで起動する。値はすべて別々の argv で渡るので、シェルが値を解釈することはない |
| Codex | `-c mcp_servers.<name>.command` / `.args` / `.env` / `.cwd`、`.url` / `.http_headers`（0.163.0 の `codex mcp list --json` で、引用符・改行・DEL を含む値が元どおりに読めることを確かめた） | `cwd` キーがそのまま効く |
| agy | workspace plugin `.agents/plugins/synapse-mcp-servers/{plugin.json,mcp_config.json}`。stdio は `command` / `args` / `env` / `cwd`、http は `serverUrl` / `headers`（`agy mcp add` が書く形） | `cwd` キーがそのまま効く（1.4.0 で実測） |

3 つとも、stdio の `env` と `cwd`、http の header が実際にサーバーに届くことを、本物の CLI で確かめた（2026-10-17）。現時点で「この CLI には渡せない」項目は無い。渡せないものが出てきたら、黙って落とさず `skipped` に理由を書く。

### Codex の値の quote

`-c` の値は TOML として読まれ、**読めなければ文字列のまま使われる**（壊れた値が黙って通る）。そのため文字列は TOML の basic string に正しく escape する（`tomlBasicString`）。`JSON.stringify` は使わない: TOML は生の DEL（U+007F）を許さず、対になっていないサロゲートを表す escape も無い。後者を含む値のサーバーは `skipped` に入る。

stdio では `args` を空でも必ず送る。Codex は `-c` の値を `~/.codex/config.toml` の同じ名前の表に**重ねる**（表ごと置き換えない）。ユーザーの設定に同じ名前のサーバーがあると、こちらが送らなかったキーが残る。特に transport が食い違う（向こうが `url`、こちらが `command`）と Codex は起動しない。**台帳の名前は、ユーザーの `~/.codex/config.toml` の名前と重ねない。**

### agy の取り下げ

台帳が空になっても、前に書いた plugin はディスクに残り、agy は読み続ける。`mcpServersLaunch("agy", …)` は渡すものが無ければ `files` を空で返すので、呼ぶ側は `withdrawMcpServersFiles("agy")`（サーバーを 1 つも挙げない `mcp_config.json`）を、**既にあるファイルにだけ**上書きする。指示書の取り下げ（[instructions.md](instructions.md)）と同じ流儀。

## 呼ぶ側との合わせ方

アプリは、スキルの server や自分で持つ HTTP のサーバー（familia の MCP Apps など）を、台帳のサーバーと合わせて渡す。

- **名前の衝突は呼ぶ側の勝ち。** 自分で渡す名前を `reserved` に入れると、台帳の同じ名前は `skipped` に入って渡らない。`skills` と `peers` は常に予約
- **Claude**: `claudeMcpConfigArgs(自分のもの, launch.mcpServers)` で 1 つの `--mcp-config` にする（先に渡した map が同じ名前で勝つ）。`--strict-mcp-config` は付けない（ユーザーの server を消すため）
- **Codex**: `[...自分の -c, ...launch.args]`
- **agy**: `{ ...自分の plugin のファイル, ...launch.files }`。plugin のディレクトリが違う（`synapse-skills` / `synapse-instructions` / `synapse-mcp-servers` / `synapse-peers`）ので重ならない

```ts
import { McpServerStore, mcpServersLaunch, claudeMcpConfigArgs } from "@synapse-chat/mcp/mcp-servers";
import { deskViewer } from "@synapse-chat/mcp/skills";

const store = McpServerStore.open(db);
// Desk の id が鍵。名前は、移し替えの前の行を読むためだけ
const ledger = store.effective(deskViewer("Homura", deskId, deskName));
const mcp = mcpServersLaunch("claude", ledger, { env: process.env, reserved: ["skills", ...myServerNames] });
const args = claudeMcpConfigArgs(claudeSkillsMcpConfig(skills).mcpServers, myServers, mcp.mcpServers);
for (const s of mcp.skipped) log.warn(`MCP server ${s.name} not delivered: ${s.reason}`);
```

## 管理用 CLI（`synapse-mcp-servers`）

```
synapse-mcp-servers list    [--effective --agent A [DESK]]
synapse-mcp-servers show    <name> [--global | --agent A [DESK]] [--effective]
synapse-mcp-servers put     <file.json> (--global | --agent A [DESK]) [--dry-run]
synapse-mcp-servers rm      <name> (--global | --agent A [DESK])
synapse-mcp-servers history <name>
synapse-mcp-servers launch  <claude|codex|agy> [--agent A [DESK]]
# DESK: --desk-id I [--desk N]（I が鍵。N は旧い鍵として読むだけ）か、--desk D（D が鍵。旧いアプリ）
```

- 指示書の CLI（`synapse-instructions`）と別の bin にした。スキル・指示書も台帳ごとに bin が分かれており、`put` の入力（JSON）も `rm` の引数（名前）も指示書と違うため
- `put` は JSON のファイル 1 つに 1 件。`--dry-run` は検査だけをして DB を開かない（作らない）
- `show` の出力はそのまま `put` に戻せる形。`--effective` はその閲覧者に勝つ版（どの階層かは stderr）
- `launch` は `mcpServersLaunch()` の結果を JSON で出す。**この CLI を動かしている環境で `${…}` を展開するので、秘密が出力に出る**
- `synapse-instructions launch … [--agent A [--desk-id I] [--desk D]]` の出力にも、`mcp` として同じものが入る（起動に載るものを 1 回で確かめる用）。指示書の `args` / `files` とは混ぜない
