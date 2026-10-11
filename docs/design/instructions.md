# 指示書を SQLite に入れて起動時に配る

エージェントの指示書（これまで `CLAUDE.md` / `AGENTS.md` に書いていたもの）を、スキルと同じ **SQLite のファイル**に置き、CLI を起動するときに **provider ごとの渡し方で常に文脈に入れる**。アプリは「どの DB の、どのエージェントの指示書を、どのディレクトリのファイルの代わりに渡すか」だけを決める。provider の作法（フラグ名、設定キー、置くファイル）はここが持つ。

実装は `@synapse-chat/mcp/instructions`（[`packages/mcp/src/instructions/`](../../packages/mcp/src/instructions/)）と、同じパッケージの bin `synapse-instructions`。

| 部品 | ファイル | |
|---|---|---|
| 置き場所 | `store.ts` | `InstructionStore`。スキルと同じ SQLite ファイルの `instruction_versions` テーブル |
| 合成 | `render.ts` | `renderInstructions()` / `effectiveInstructions()` / `readInstructionFile()` |
| 起動時の渡し方 | `launch.ts` | `instructionsLaunch()` / `withdrawInstructionsFiles()`。値を返すだけで、ファイルは書かない |
| 管理用 CLI | `cli.ts` | `synapse-instructions list / show / import / export / rm / history / launch` |

スキル（[skills-mcp.md](skills-mcp.md)）と違い、**MCP サーバーは無い。** 指示書は「必要なときに取りに行くもの」ではなく「最初から全部読んでいるもの」なので、起動の引数・system prompt・起動前に置くファイルで渡す。

## 階層

**全員 → エージェント の 2 つ。Desk の階層は無い。**

| 階層 | キー（`agent`） | 誰が読むか |
|---|---|---|
| 全員 | `""` | 全エージェント |
| エージェント | `"Tsukuyo"` | そのエージェントの全セッション |

**合成は「全員」の後ろに「エージェント」を足すだけ**（`renderInstructions`）。スキルのように同じ名前で上書きする単位が無いので、勝ち負けではなく連結にした。食い違うときは後ろ（エージェント）の文が後から読まれる。

- どちらの階層にも見出し `## スキル` が無ければ、スキルの案内（`SKILLS_AGENTS_MD_GUIDANCE`）を**先頭に**足す。Codex はこれが無いとスキルの MCP を使わない（[skills-mcp.md](skills-mcp.md#モデルにスキルを知らせる)）。`skillsGuidance: false` で外せる
- 両方とも空なら空文字を返す（案内だけの指示書は作らない）

## 版と削除

スキルと同じ規則にそろえた。

- **書き込みは毎回、新しい行。** 既存の版は書き換えない。本文が最新版と同じなら版を作らない（改行コードと末尾の空行の違いは同じとみなす）
- **版の番号は階層ごと。** 1 つの階層が 1 つの文書なので、スキルのように名前をまたいで採番する理由が無い
- **削除は印（tombstone）の行を足すだけ。** 前の版は残る。同じ階層にまた書けば、版は続きから
- 空の本文は書けない（消すなら `rm`）

## 置き場所

**スキルと同じファイル**（`--db`、`$SYNAPSE_SKILLS_DB`、既定 `~/.local/share/synapse-skills/skills.db`）に、別のテーブルとして入る。

- 消すと戻らないデータが 1 か所にまとまり、バックアップも 1 つで済む
- スキーマの版は `meta` の別のキー（`instructions_schema_version`）で持つ。スキルの `schema_version` には触らないので、指示書を知らない古い版の `SkillStore` も同じファイルをそのまま開ける
- WAL・`busy_timeout = 5000`・採番は `BEGIN IMMEDIATE` の中、はスキルと同じ

## 書き込みの権限

**書けるのは管理用 CLI だけ**（`synapse-instructions import` / `rm`）。書き込む階層は `--global` か `--agent <名前>` で必ず名指しする（省略で全員に書かない）。MCP から指示書を書く道は無い。

## 起動時の渡し方（`instructionsLaunch`）

入力は合成した本文（`text`）、セッションの cwd、**置き換えるディレクトリ**（`replaces`。そのディレクトリの指示ファイルの代わりにこの本文を渡す、という意味）。返すのは次の 4 つで、アプリはそれを起動に載せるだけでよい。

| 返り値 | 中身 |
|---|---|
| `systemPromptAppend` | system prompt の末尾に足す文字列 |
| `args` | CLI の引数に足すもの |
| `files` | 起動の前に cwd の下へ書くファイル（`相対パス → 中身`） |
| `stillLoaded` | **止められなかった**指示ファイルの候補（絶対パス。無いこともある）。あれば同じ指示が二重に入るので、アプリが警告する |

| CLI | 本文の渡し方 | 置き換えるファイルを読ませない方法 |
|---|---|---|
| Claude Code | `--append-system-prompt`（`systemPromptAppend`） | `--settings '{"claudeMdExcludes":[…]}'` |
| Codex | `-c developer_instructions="…"` | `-c project_doc_max_bytes=0`（cwd が置き換え対象のときだけ） |
| agy | workspace plugin の always-on の rule（`.agents/plugins/synapse-instructions/rules/*.md`） | **止める手段が無い**。`stillLoaded` に `AGENTS.md` / `GEMINI.md` を返す |

**本文が空なら何もしない**（引数もファイルも足さず、ファイルの指示書も止めない）。止めたうえで何も渡さないと、指示書の無いエージェントが起動するため。

### Claude Code

- **本文は system prompt に足す。** system prompt はリクエストのたびに送られるので常に文脈にあり、`--resume` でも起動のたびに今の版が入る
- **ファイルは `claudeMdExcludes` で外す。** 置き換える各ディレクトリについて `CLAUDE.md`・`CLAUDE.local.md`・`AGENTS.md`・`.claude/CLAUDE.md`・`.claude/rules/**` を外す。`--settings` で渡すので、ユーザーやプロジェクトの設定ファイルには書かない
- **`AGENTS.md` も外す。** `CLAUDE.md` を外したディレクトリに `AGENTS.md` があると、Claude Code はそれを読む（2.1.287 で実測。`CLAUDE.md` が無いディレクトリの `AGENTS.md` は読まなかった）
- パターンは絶対パスで照合される。与えられたパスと `realpath` の両方を入れる（macOS の `/tmp` は `/private/tmp`）。パスの中の glob の記号はエスケープする
- **`CLAUDE_CODE_DISABLE_CLAUDE_MDS` と `--bare` は使わない。** 前者はユーザーの `~/.claude/CLAUDE.md` も、作業する repo の `CLAUDE.md` も全部消す。後者は OAuth の認証まで読まなくなる。置き換えるものだけを外す

### Codex

- **本文は `developer_instructions`。** developer message としてスレッドの最初に入る。`-c` で渡すので `~/.codex/config.toml` には書かない
- **`AGENTS.md` は `project_doc_max_bytes=0` で止める。** Codex は git root から cwd までの `AGENTS.md` を読み、ファイルごとに外す設定は無い。全部止めるか全部読むかなので、**cwd 自体が置き換え対象のときだけ**止める。cwd より上のディレクトリだけが置き換え対象なら止めず、その `AGENTS.md`（と `AGENTS.override.md`）を `stillLoaded` に返す
- **再開したスレッドには、始めたときの指示書が残る。** `codex exec resume` に別の `developer_instructions` を渡しても、モデルが答えたのは最初の版だった（0.153.4 で実測）。指示書を直したら、新しいスレッドで読み直させる。`AGENTS.md` もスレッドの開始時に読まれるので、ファイルのころと同じ

### agy

- **本文は workspace plugin の rule。** agy には system prompt を足すフラグが無い（[cli-adapter-guide](../cli-adapter-guide.md)）。plugin の `rules/` に `trigger: always_on` の Markdown を置くと、毎ターン文脈に入る（1.3.3 で実測）。plugin はスキルの登録と同じく `.agents/plugins/<名前>/` に置き、`~/.gemini` には書かない
- **rule は 1 ファイル 24,000 バイトまで**（超えた分は切り捨てられる）。本文を見出しの境目で 23,000 バイト以下に分け、`instructions-01.md` 〜 `instructions-08.md` に入れる。**8 枠は毎回全部書く。** 使わない枠は本文なしの `trigger: manual` にする。本文が短くなったときに古い rule が残らないようにするため（ファイルを消す API にはしない）。8 枠に入りきらなければ throw する
- **always-on の rule は合わせて 20,000 トークンまで**（agy の `defaultRulesBudget`）。超えた rule は本文の代わりにファイルのパスだけが文脈に入り、モデルが必要なときに読む。長い指示書は agy では全文が常に入るとは限らない
- **`AGENTS.md` は止められない。** agy は cwd から repository root までの `AGENTS.md` / `GEMINI.md` を必ず読み、外す設定が無い。`stillLoaded` に返すので、アプリが警告し、ファイルの指示書を退避（rename）するまで二重に入る
- **取り下げ（`withdrawInstructionsFiles("agy")`）。** DB の指示書をやめたあとも plugin はディスクに残り、agy は読み続ける。取り下げのファイル（8 枠とも空の `trigger: manual`）を、**既にあるファイルにだけ**上書きする。一度も配っていないディレクトリには何も書かない

## 管理用 CLI（`synapse-instructions`）

```
synapse-instructions list
synapse-instructions show    [--global | --agent A] [--effective]
synapse-instructions import  <file> (--global | --agent A) [--dry-run]
synapse-instructions export  (--global | --agent A) --out <file> [--force]
synapse-instructions rm      (--global | --agent A)
synapse-instructions history (--global | --agent A)
synapse-instructions launch  <claude|codex|agy> --cwd <dir> [--agent A] [--replace <dir>]...
```

- `import` はファイルから Briefing の指紋の行（`<!-- briefing:v1 fingerprint=… -->`）を外して入れる。`--dry-run` は DB を開かない（作らない）
- `show --agent A --effective` はそのエージェントのセッションに入る本文（全員＋エージェント＋スキルの案内）
- `launch` は `instructionsLaunch()` の結果を JSON で出す。起動に何が載るかを確かめる用

## 確かめ方

階層ごと・ファイルごとに別の合言葉を仕込み、「指示に書かれた合言葉を全部挙げて。ツールは使わない」と訊く。DB の 2 つだけが返り、ファイルの合言葉が返らなければよい。`stillLoaded` の確認は、`AGENTS.md` を置いたまま agy に訊くと、ファイルの合言葉も返る（二重に入っている）ことで分かる。
