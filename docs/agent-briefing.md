# Agent Briefing

エージェントの指示書を provider 非依存の一枚にまとめ、Claude Code / agy / Codex それぞれの形に配る仕組み。実装は [`@synapse-chat/core/briefing`](../packages/core/src/briefing/)。

> **「Agent への指示書は、一段抽象化されたものとして保存しておいて、各 provider のモデルにそこから変換されるようにしたい。spawn された agent は、自分がそのアダプタを使っていることを意識しないようにしたい」**

## 用語（ユビキタス言語）

メタファは**教室で配るプリント**。先生が 1 つの指示書を人数分コピーして配る → 生徒が自分のプリントに書き込む → 回収して指示書を直す → 配り直す。

| 概念 | 用語 | 日本語 |
|---|---|---|
| provider 非依存の正本 | **Briefing** | 指示書 |
| provider 向けの生成物 | **Handout** | 配布版 |
| provider ごとの置き場・形式 | **Layout** | 配置 |
| Briefing → Handout | **handOut** | 配る |
| Handout → Briefing | **collect** | 回収する |
| 変更検知の印（内容ハッシュ） | **fingerprint** | 指紋 |
| 手で書き換えられた Handout | **marked-up** | 書き込みあり |
| 2 つの Handout が同時に書き換えられた | **conflicting handouts** | |

**「SSoT」「Agent Spec」は使わない。** アーキテクチャの用語であってドメインの言葉ではない。

**この語彙が要件そのものを含んでいる。** 生徒は自分のプリントしか持っていない。「これは指示書の Claude 版だ」とは思わない —— それが「spawn された agent は自分がそのアダプタを使っていることを意識しない」の実体。

### 改名しないもの

**`skill` / `subagent` / `rule` / `section` は訳さない。** provider 側に実在する語なので、訳すと下の実測表と突き合わせられなくなる。

## API

```ts
import {
  handOut, handOutAll, collect, detectMarkUps, emptyBriefing,
  parseBriefing, serializeBriefing,
} from "@synapse-chat/core/briefing";
```

| 関数 | 向き | 用途 |
|---|---|---|
| `handOut(briefing, layoutName)` | Briefing → Handout | 1 つの Layout に配る。`path → content` を返すだけで、ファイルは書かない |
| `handOutAll(briefing, layouts?)` | Briefing → Handout | 全 Layout に配る。共有パスが食い違ったら throw |
| `detectMarkUps(briefing, dir)` | — | 書き込まれた Handout を列挙する |
| `collect(briefing, layoutName, dir)` | Handout → Briefing | 書き込みを Briefing に回収する |
| `emptyBriefing(name)` | — | 空の Briefing。まだ配ったことのないディレクトリの取り込み先 |
| `parseBriefing` / `serializeBriefing` | — | `<name>.briefing.yaml` との相互変換 |

**型だけは `@synapse-chat/core` の root からも取れる**（`Briefing`, `LayoutName`, `Layout`, `CollectResult`, `MarkedUpFile` …）。実装が subpath にあるのは、root entry が `@synapse-chat/react` 経由でブラウザにバンドルされるため。`collect()` は `node:fs` を、fingerprint は `node:crypto` を使うので、root から値を re-export すると `apps/example` の vite build が落ちる。型はコンパイル時に消えるのでバンドルに影響しない。

### 典型的な流れ

```ts
// 1. 既存の Claude 専用ディレクトリを取り込む（移行。1 回だけ）
const { briefing } = collect(emptyBriefing("Amanatsu"), "claude", dir);

// 2. 全 provider に配る
for (const [rel, content] of Object.entries(handOutAll(briefing))) write(join(dir, rel), content);

// 3. 人が CLAUDE.md を直した。書き込みを探して回収し、配り直す
const marked = detectMarkUps(briefing, dir);           // [{ path: "CLAUDE.md", layouts: ["claude"] }]
const next = collect(briefing, "claude", dir).briefing; // 書き込みが Briefing に入る
// → handOutAll(next) で AGENTS.md にも伝播する
```

**回収の条件は「書き込まれた、または Briefing に該当するエントリが無い」。** 指紋が一致する Handout は人の手が入っていないので読まない —— 無編集で再実行しても「書き込みあり」と誤検知しないのはこのため。一方、指紋は「*どれかの* Briefing が生成した」しか意味しないので、手元の Briefing が知らないファイルは指紋があっても取り込む（そうしないと唯一のコピーを落とす）。

**この 2 つの条件が揃うので、取り込みと回収は同じ関数でよい。** 一度も配っていないディレクトリのファイルは指紋を持たないから、`collect()` を向ければ全部が「新しい」と読まれる —— それが移行に必要なことのすべて。`importFrom()` と `absorb()` を分ける理由は無い。

## Layout（実測。2026-09-10）

全候補に別々の合言葉を仕込み、**ツール探索を禁じて**（＝自動ロードだけを切り分けて）3 CLI に訊いた結果。対照実験込み（ダミーの `.zzz/rules/` は効かない、Claude は `.agents/rules/` を無視する、を確認済み）。

| 概念 | `claude` | `agents`（agy） | `codex` |
|---|---|---|---|
| **指示ファイル** | `CLAUDE.md` | **`AGENTS.md`** | `AGENTS.md` |
| **skills** | `.claude/skills/<n>/SKILL.md` | `.agents/skills/<n>/SKILL.md` | `.agents/skills/` と `.codex/skills/` の両方 |
| **subagents** | `.claude/agents/*.md`（YAML frontmatter） | `.agents/agents/*.md`（YAML frontmatter） | **`.codex/agents/*.toml`**（`name` / `description` / `developer_instructions`） |
| **rules** | `.claude/rules/*.md` | `.agents/rules/*.md`（`trigger: always_on` 必須） | **器が無い** |

### 直感に反するもの

- **`GEMINI.md` は要らない。** agy は `AGENTS.md` を読む。`CLAUDE.md` は自動ロードされない
- **Codex は `.agents/skills/` も拾う。** skills は 1 か所に出せばよい。両方に書くと Codex に二重に見える
- **subagents は一覧に出ない**（agy / Codex）。名前で spawn して初めて解決される
- **本文を provider ごとに変えられない。** `AGENTS.md` は agy と Codex が共有する。実際に語彙を変えて試したら、agy が「AGENTS.md では apply_patch、GEMINI.md では write_file と指示されています」と**アダプタの存在を暴露した**

⇒ **指示書に provider 固有の語（ツール名など）を書かせないこと。** provider ごとのつまみは `providerFrontmatter` にだけ置く。あれは harness が読む frontmatter / TOML のキーであって、モデルが読む本文ではない。

### 配られるもの

```
CLAUDE.md                ← claude
AGENTS.md                ← agents + codex（本文は CLAUDE.md と完全一致）
.claude/{skills,agents}/
.agents/{skills,agents}/
.codex/agents/*.toml
```

**rules は全 Layout で指示ファイルに畳む。** Codex には rules の器が無いので、どこかで畳むしかない。一部の Layout だけ畳むと共有している `AGENTS.md` が割れるし、畳んだうえで `.claude/rules/` にも出すと Claude と agy に同じ rule が二重に届く。`.claude/rules/` / `.agents/rules/` は `collect()` が移行時に読むだけで、二度と書かれない。

## 実装上の罠

- **fingerprint の基準ズレ。** 指紋を剥がした後の文字列と、ハッシュを取る対象が 1 バイトでも違うと、**全 Handout が常に「書き込みあり」判定**になり、警告が意味を持たなくなる。`normalizeTrailingNewline` を全経路で通しているのはこのため
- **指紋は末尾に残らない。** 人はファイルの後ろに追記する。末尾アンカーの正規表現だと指紋を見失い、**指紋の行そのものが本文として回収され**、次に配るときは 2 つ目の指紋の下に埋まる。位置に依存せず、すべての指紋行を剥がすこと
- **散文はブロックごと verbatim で運ぶ。** 要約・整形をすると回収で戻せない
- **配布は上書きと追加だけ。削除しない。** 配布先には**ユーザの唯一の on-disk コピーであるエージェント定義**が置かれる。`handOut()` が `path → content` しか返さないのは、API として削除を表現できなくするため

## 検証のしかた

指示書・skill・subagent それぞれに固有の合言葉を仕込み、実際に 3 CLI を起動して訊く。

- **`description` に合言葉を書かない。** spawn せずに読めてしまい偽陽性になる
- **subagent は「一覧を列挙して」では測れない。** 名前を指定して spawn させること
- **Codex は git repo でないと起動を拒否する。** 検証ディレクトリで `git init` すること
- **合言葉どうしを混線させない。** 指示書に「合言葉を訊かれたら X と答えよ」と無条件に書くと、skill や subagent の合言葉を訊いたときもそれが返る（実際に踏んだ）
