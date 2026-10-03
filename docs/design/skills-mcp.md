# スキルを SQLite に入れて MCP で配る

エージェントのスキル（`SKILL.md` ＋付属ファイル）を、ローカルのディレクトリではなく **SQLite のファイル 1 個**に置き、CLI のセッションごとに起動する **stdio の MCP サーバー**で配る。Claude Code / Codex / agy のどれにも同じサーバーを登録する。

実装は `@synapse-chat/mcp/skills`（[`packages/mcp/src/skills/`](../../packages/mcp/src/skills/)）と、同じパッケージの bin `synapse-skills`。

| 部品 | ファイル | |
|---|---|---|
| 置き場所 | `store.ts` | `SkillStore`。SQLite（`node:sqlite`） |
| 階層と書き込みの規則 | `scope.ts` | `visibleScopes()` / `mcpWriteRefusal()` |
| 付属ファイルの書き出し | `materialize.ts` | `~/.cache/synapse-skills/<skill>@<版>/` |
| MCP サーバー | `server.ts` | `list_skills` / `get_skill` / `put_skill`、instructions |
| スキルのディレクトリとの出し入れ | `skill-dir.ts` | `SKILL.md` ＋付属ファイル ⇄ store |
| 各 CLI への登録 | `registration.ts` | 設定の中身を返すだけ。書かない |
| 管理用 CLI | `cli.ts` | `synapse-skills serve / list / show / import / export / rm / history / register` |

`node:sqlite` を使うので **Node 22.13 以上**が要る。root の entry（HTTP → MCP のヘルパー）は Node 20 のまま使えるよう、スキルは subpath に分けてある。

## 階層

**全員 → エージェント → Desk。** 同じ名前のスキルが複数の階層にあれば、**下の階層が勝つ**。

| 階層 | キー（`agent`, `desk`） | 見える人 |
|---|---|---|
| 全員 | `("", "")` | 全員 |
| エージェント | `("Tsukuyo", "")` | そのエージェントの全セッション |
| Desk | `("Tsukuyo", "artiflow")` | その Desk のセッションだけ |

上書きは自分にしか効かない。エージェント A が全員の `issue-draft` を上書きしても、B には全員の版が見えたまま。**上書きを消すと、全員の版がまた見える**（削除の印は、上の階層を隠さない）。

## 版と削除

- **書き込みは毎回、新しい行。** 既存の版は書き換えない。中身（説明・本文・frontmatter・付属ファイル）が最新版と同じなら版を作らない（同じディレクトリを何度 import しても版が増えない）
- **版の番号はスキル名ごとに、階層をまたいで 1 本。** 全員の `readtime` が v1、A の上書きが v2、全員の次の版が v3。だから `<skill>@<版>` が 1 つの store の中で 1 行に決まり、書き出し先のディレクトリが衝突しない
- **削除は印（tombstone）の行を足すだけ。** 前の版は残る。同じ名前で書けば復活する（版は続きから）

## 付属ファイル

スキルと一緒に登録できる（`skill_files` テーブル。中身・相対パス・実行ビット）。`get_skill` が呼ばれると `~/.cache/synapse-skills/<skill>@<版>/`（`$XDG_CACHE_HOME` があればその下）に書き出し、**実行ビットを保ったうえで**絶対パスを返す。

- 一時ディレクトリに書いて rename する。同時に動く別セッションが書きかけのスクリプトを実行することはない
- 版は不変なので、既にあるディレクトリはそのまま使う。ただし中の `.synapse-skill.json` の digest が違えば（別の store の同じ `<skill>@<版>` —— テスト用の store と本物など）書き直す
- 版を上げると別のディレクトリになる。古い版のディレクトリは消さない（キャッシュなので、消しても次の `get_skill` で戻る）
- **既に repo にあるスクリプトは登録しない。** スキルの本文から repo のパスで呼べばよい。付属ファイルは「スキルにしか無いもの」だけ
- 付属ファイルのパスは、スキルのディレクトリの中に収まる相対パスだけ（`..`・絶対パス・`SKILL.md` は拒否）

`put_skill` / `import` で付属ファイルを**渡さない**と、書き込む階層からいま見えている同名スキルのファイルを引き継ぐ（本文だけ直してもスクリプトが消えない）。`files: []` で全部外す。説明・frontmatter も同じく引き継ぐ。

## 書き込みの権限

| 経路 | 書ける階層 |
|---|---|
| MCP の `put_skill` | **自分のエージェントの階層**（既定）か、`scope: "desk"` で**自分の Desk の階層**だけ |
| 管理用 CLI（`synapse-skills import` / `rm`） | どこでも。ただし **`--global` か `--agent <名前>` を必ず書く**（省略で全員に書かない） |

- **全員の階層は MCP からは書けない。** 全員が使うスクリプトを 1 人のエージェントが壊せないように。直すときは人（か、それを頼まれたエージェント）が CLI で `--global` を付けて書く
- **`put_skill` には書き込み先を指す引数が無い。** 階層は起動引数の `--agent` / `--desk` からしか決まらないので、ほかのエージェントや全員の階層を名指しする手段がそもそも無い。規則は `scope.ts` の `mcpWriteRefusal()` 1 か所にある
- `--agent` の無いセッションと `--read-only` のセッションには `put_skill` を**出さない**
- これは事故を防ぐための線で、悪意への防御ではない。シェルが使えるエージェントは CLI も DB ファイルも触れる
- **非対話の Codex（`codex exec`）も `put_skill` を呼べる。** `put_skill` に `destructiveHint: false` / `openWorldHint: false` を付けてあるので承認を求められない（annotations を外すと `requires approval, but approval policy is never` で落ちる。Codex 0.153 で実測）。書けるのは自分の階層だけで、前の版も残るので、承認なしで通してよいことにした

## どのエージェントか（起動引数）

サーバーは**起動引数**で自分が誰に仕えるかを知る。

```
node …/dist/skills/cli.js serve --db /abs/skills.db --agent Tsukuyo [--desk artiflow] [--read-only] [--cache-dir …] [--log …]
```

**環境変数では受けない。** 環境変数は子プロセスに黙って引き継がれる（アプリのサーバー → CLI → その CLI が起動した別の CLI → その MCP サーバー）ので、別のエージェントとして動く事故が起きる。起動引数なら、そのセッションの登録 1 か所にしか書かれない。

`--agent` が無ければ全員の階層だけが見え、書けない。

## 置き場所の既定

| | 既定 | 上書き |
|---|---|---|
| DB | `~/.local/share/synapse-skills/skills.db`（`$XDG_DATA_HOME` があればその下） | `--db`、`$SYNAPSE_SKILLS_DB` |
| 書き出し | `~/.cache/synapse-skills/` | `--cache-dir` |

DB は消すと戻らないデータなので data の場所、書き出しは何度でも作り直せるので cache の場所。どちらも repo の外なので commit されない。**アプリは DB を必ず絶対パスで渡す**（登録の関数は相対パスを拒否する）。CLI ごとにサーバーの cwd が違う（agy は plugin のディレクトリ）ので、相対パスは当てにならない。

SQLite は WAL・`busy_timeout = 5000`。セッションの数だけサーバーが同じファイルを開く。版の採番は `BEGIN IMMEDIATE` の中でやるので、2 つのセッションが同時に書いても同じ版番号にならない。

## モデルにスキルを知らせる

| | 届くもの |
|---|---|
| **instructions**（`initialize` の応答） | 「仕事が当てはまれば先に `get_skill`」という案内と、**そのセッションから見えるスキルの名前と説明の一覧**。起動時に 1 回作る |
| **`AGENTS.md` の案内**（`SKILLS_AGENTS_MD_GUIDANCE`） | 「スキルは MCP の `skills` にある。始める前に `list_skills` を見て、当てはまれば `get_skill`」。スキル名は書かない |

**Codex には instructions が届かない**ので、`AGENTS.md` の案内が必須。Claude には instructions だけで届くが、案内が `CLAUDE.md` に入っていても害は無い（Briefing で同じ文を配ってよい）。

ツール:

| ツール | annotations | |
|---|---|---|
| `list_skills` | `readOnlyHint: true` | 名前・版・階層・説明 |
| `get_skill` | `readOnlyHint: true` | 本文と、付属ファイルの絶対パス |
| `put_skill` | `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` | 自分の階層に新しい版を書く |

## 各 CLI への登録

ユーザーの全体設定（`~/.claude`・`~/.codex`・`~/.gemini`）には書かない。`registration.ts` は設定の中身を返すだけで、ファイルには書かない（`synapse-skills register <cli>` で同じものが出る）。

| CLI | 登録 | 関数 |
|---|---|---|
| Claude Code | `claude --mcp-config <file> --strict-mcp-config`（`.mcp.json` でも可） | `claudeSkillsMcpConfig()` |
| Codex | `codex exec -c 'mcp_servers.skills.command="…"' -c 'mcp_servers.skills.args=[…]'`（`config.toml` の `[mcp_servers.skills]` と同じ） | `codexSkillsConfigArgs()` / `codexSkillsConfigToml()` |
| agy | ワークスペースに `.agents/plugins/<名前>/plugin.json` ＋ `mcp_config.json` | `agySkillsPluginFiles()` |

`command` は既定で**いま動いている Node の絶対パス**（`process.execPath`）。PATH の `node` が古い（22.13 未満）と `node:sqlite` が無いため。登録はセッションを起動するたびに作り直す前提で、Node を上げたら次の起動から新しいパスになる。

Claude で `--permission-mode` を `bypassPermissions` にしないなら、`--allowedTools mcp__skills__list_skills,mcp__skills__get_skill` を足す。

## 罠

- **Codex は MCP の instructions をモデルに渡さず、MCP のツールを常に `tool_search` の奥に隠す。** `AGENTS.md` の案内が無いとスキルの存在を知らない
- **非対話の Codex は、annotations の無い MCP ツールを承認待ちで落とす**（approval policy が never）。`list_skills` / `get_skill` には `readOnlyHint: true`、`put_skill` には `destructiveHint: false` / `openWorldHint: false` を付けてある。annotations を消すと Codex から使えなくなる
- **ファイル版と MCP 版のスキルが両方あると、どちらが発動するか分からない。** DB に入れたスキルは、ファイル版を消す
- **`codex exec` は stdin が開いていると待ち続ける。** 非対話で回すときは `< /dev/null`
- **agy は plugin のディレクトリを cwd にしてサーバーを起動する。** パスは全部絶対パスで書く
- **`node:sqlite` は静的に import しない。** `node:` を外して解決する bundler / vite-node（vitest）が `sqlite` を探して落ちる。`process.getBuiltinModule("node:sqlite")` で読む

## 確かめ方

スキル名を言わずに頼み、スキルを読まないと書けない固有の規則（最終行の合言葉、付属スクリプトだけが出せる receipt）が出力に出るかで判定する。`--log <file>` を付けるとサーバーが `initialized` / `tools/list` / `tools/call` を JSONL で残すので、どのスキルを取りに行ったかも分かる。Claude は `--setting-sources project` でユーザーのスキルを外して測る（同じ用途のファイル版スキルと競合するため）。
