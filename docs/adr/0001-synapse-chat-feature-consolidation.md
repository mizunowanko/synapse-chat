# ADR-0001: synapse-chat フィーチャー統合 — vibe-admiral / agents-familia 自前実装の吸収

## ステータス

Proposed

## コンテキスト

synapse-chat のスコープ定義:「ビジネスロジックを含まない Claude/Gemini CLI のラッパー＋チャット UI 用コンポーネント」

vibe-admiral と agents-familia はいずれも `@synapse-chat/*` パッケージの重いユーザーだが、本来 synapse-chat が提供すべきチャット UI プリミティブを各自で自前実装している箇所が複数存在する。これにより:

- 同一ロジック・スタイルの二重メンテナンスが発生している
- 新規アプリケーションが synapse-chat を採用した際、同じ車輪を再発明することになる
- バグ修正や改善が片側にしか反映されないリスクがある

本 ADR では調査結果に基づき、synapse-chat に統合すべき機能を特定し、提案する API shape と breaking change リスクを記述する。

### 調査対象

| リポジトリ | 調査済みファイル |
|---|---|
| vibe-admiral | `src/components/chat/ChatMessage.tsx`, `src/components/bridge/SystemMessageCard.tsx`, `src/components/session/SessionMessage.tsx`, `src/globals.css`, `src/lib/ship-status.ts` |
| agents-familia | `src/components/session/SessionChat.tsx`, `src/components/session/AvatarModal.tsx`, `src/components/handoff/HandoffModal.tsx` |

---

## 決定事項

以下 **5 機能**を synapse-chat (`@synapse-chat/react`) に統合する。

---

## 機能 1: コンパクション可視化コンポーネント

### 問題

Claude CLI は context 圧縮（compaction）発生時に `subtype: "compacting"` を含む `system` メッセージを stream に流す。vibe-admiral の `ChatMessage.tsx`（現行 ~15 行）がこれを独自検出してアニメーション付きバッジで表示しているが、synapse-chat 側には UI がない。

agents-familia は compaction を視覚化していない（検出もしていない）。

### synapse-chat に持つべき理由

- compaction は Claude CLI の汎用ライフサイクルイベントであり、ビジネスロジックではない
- Claude API を使うすべてのチャット UI が同じ表示ニーズを持つ
- vibe-admiral の実装が流用元になるため、移植コストが低い

### 提案 API shape

#### a) `StreamMessage.subtype` 拡張

`@synapse-chat/core` の `parseStreamMessage` が `subtype: "compacting"` を既存の `subtype` フィールドとして透過的に渡す（変更不要の可能性が高い—要確認）。

#### b) `CompactionBadge` コンポーネント

```typescript
// packages/react/src/components/CompactionBadge.tsx
export interface CompactionBadgeProps {
  className?: string;
}

export function CompactionBadge({ className }: CompactionBadgeProps): ReactElement;
```

#### c) `ChatMessage` への自動統合

`ChatMessage` が `message.subtype === "compacting"` を検出した場合、自動的に `CompactionBadge` をレンダリングする。`renderSystem` コールバックで上書き可能。

### Breaking Change リスク

**低**。新コンポーネント追加 + `ChatMessage` の既存 `system` メッセージ描画パスへの分岐追加のみ。既存の `renderSystem` prop による上書きは引き続き機能する。

---

## 機能 2: Markdown デフォルトスタイル (CSS)

### 問題

vibe-admiral の `globals.css` に `.bridge-markdown` / `.synapse-chat-markdown` として ~136 行の Markdown CSS が存在する。テーブル罫線、コードブロック、見出し、引用ブロックなどを整形している。remark-gfm を有効にしても CSS がなければテーブルは罫線なしで表示される。

### synapse-chat に持つべき理由

- `ChatMessage` は `remark-gfm` を有効にしてテーブルを HTML に変換するが、スタイルを持たないため利用側 CSS に依存している
- CSS ゼロの状態でもテーブルが正しく見えるべきである
- 複数アプリがほぼ同一の CSS をコピーしている

### 提案 API shape

#### a) デフォルト CSS の同梱

```
packages/react/src/styles/
  chat-message.css        ← table, code, list, blockquote スタイル
```

`@synapse-chat/react` の `package.json` に `exports["./styles"]` を追加し、消費側が `import "@synapse-chat/react/styles"` で取り込めるようにする。

#### b) CSS Custom Properties による Theme 拡張

```css
/* デフォルト値 */
:root {
  --synapse-chat-border: #e2e8f0;
  --synapse-chat-code-bg: #f8fafc;
  --synapse-chat-muted: #64748b;
}
```

消費側は CSS 変数を上書きするだけでテーマを変更できる。

#### c) `ChatMessage` の className 維持

既存の `className` prop はそのまま。内部的に `synapse-chat-message` を付与し、スコープ付きスタイルを適用する。

### Breaking Change リスク

**中**。既存の消費側がテーブル罫線なしを前提にレイアウト計算している場合、追加スタイルが視覚的な変化を引き起こす可能性がある。ただし opt-in (`import "@synapse-chat/react/styles"`) にすることで既存動作に影響を与えない実装が可能。

---

## 機能 3: レート制限・接続ライフサイクルバッジ

### 問題

vibe-admiral の `SessionMessage.tsx` に以下の状態バッジが散在している（各 ~10–20 行）:
- "Rate limit — retrying..." (amber)
- "connected" / "disconnected" / "Failed" (green/red/gray)

これらは CLI プロセスの汎用ライフサイクル状態であり、ビジネスロジックに依存しない。

### synapse-chat に持つべき理由

- レート制限と接続状態は `@synapse-chat/server` が管理するイベント（`rate-limit`, `exit`, `error`）であり、UI とペアになるべき
- あらゆる Claude CLI チャット UI で同じ表示ニーズがある
- 現在 `useConnectionStatus` フックは値を返すが、それを表示するコンポーネントが存在しない

### 提案 API shape

#### `ConnectionStatusBadge` コンポーネント

```typescript
// packages/react/src/components/ConnectionStatusBadge.tsx
export type ConnectionStatusBadgeVariant = "default" | "compact";

export interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;            // "connected" | "disconnected" | "reconnecting"
  isRateLimited?: boolean;
  className?: string;
  variant?: ConnectionStatusBadgeVariant;
}

export function ConnectionStatusBadge(props: ConnectionStatusBadgeProps): ReactElement | null;
```

`status === "connected"` のときは `null` を返す（接続中は非表示がデフォルト）。

#### `ChatMessage` への統合

`message.type === "system"` かつ `message.subtype === "rate-limit"` / `"connected"` / `"disconnected"` を検出した場合に自動レンダリング。

### Breaking Change リスク

**低**。新コンポーネント追加のみ。既存の `renderSystem` コールバックで上書き可能。

---

## 機能 4: コラプシブル出力カード（CollapsibleOutput）

### 問題

vibe-admiral の `ChatMessage.tsx` に `RequestResultCard` (~30 行) がある。長いツール結果・Engine 出力を「3 行を超えたら折りたたむ」パターンで実装している。

現行の `ToolUseGroup` はツール use/result のグループ化・折りたたみを提供するが、**個々のテキストブロックの展開/折りたたみ**はカバーしていない。

### synapse-chat に持つべき理由

- 長い CLI 出力を折りたたむ UI パターンはあらゆるチャットアプリで有用
- `ToolUseGroup` と組み合わせることで、ツール結果の詳細表示を統一的に制御できる

### 提案 API shape

```typescript
// packages/react/src/components/CollapsibleOutput.tsx
export interface CollapsibleOutputProps {
  content: string;
  maxLines?: number;        // デフォルト: 3
  label?: string;           // 折りたたみ時のサマリラベル（省略時: 最初の行）
  className?: string;
  defaultExpanded?: boolean;
}

export function CollapsibleOutput(props: CollapsibleOutputProps): ReactElement;
```

#### `ToolUseGroup` / `ChatMessage` への統合オプション

`ToolUseGroup` の `maxOutputLines` prop（opt-in）で長い `tool_result` を自動折りたたみ。

```typescript
export interface ToolUseGroupProps {
  group: ToolUseGroupItem;
  context?: ChatMessageContext;
  maxOutputLines?: number;   // 追加: undefined のとき折りたたみなし（後方互換）
}
```

### Breaking Change リスク

**低**。`CollapsibleOutput` は新規エクスポート。`ToolUseGroup` の変更は prop 追加（optional）のみ。

---

## 機能 5: システム通知バッジ汎化（SystemMessageRenderer）

### 問題

vibe-admiral の `SystemMessageCard.tsx` (~150 行) は、`message.subtype` の値に応じてスタイルを切り替えるバッジを描画する。現状は vibe-admiral 固有の subtype（`gate-check-request`, `lookout-alert` 等）にハードコードされているが、**パターン自体**（subtype → 色/アイコン/テキストのマッピングを渡してバッジを描画）は汎用的。

### synapse-chat に持つべき理由

- `ChatMessage` の `renderSystem` prop は現在 `ReactNode | null` を返すだけであり、消費側が毎回バッジ UI をゼロから構築する必要がある
- 型ベースのスタイルマップ + バッジ共通 UI をプリミティブとして提供すれば、各アプリはマッピング定義だけを書けば良い

### 提案 API shape

```typescript
// packages/react/src/components/SystemMessageBadge.tsx
export interface SystemMessageVariantConfig {
  label: string;
  icon?: string;                        // emoji or icon identifier
  colorClass?: string;                  // Tailwind or CSS class
}

export interface SystemMessageBadgeProps {
  subtype: string;
  variants: Record<string, SystemMessageVariantConfig>;
  fallback?: ReactNode;                 // subtype が variants にない場合の fallback
  className?: string;
  message?: StreamMessage;              // metadata アクセス用（optional）
}

export function SystemMessageBadge(props: SystemMessageBadgeProps): ReactElement | null;
```

消費側（vibe-admiral）での使用例:

```typescript
<SystemMessageBadge
  subtype={message.subtype ?? ""}
  variants={{
    "gate-check-request": { label: "Gate Check", icon: "🔍", colorClass: "bg-indigo-100 text-indigo-800" },
    "lookout-alert":      { label: "Alert",      icon: "🚨", colorClass: "bg-red-100 text-red-800" },
  }}
  message={message}
/>
```

### Breaking Change リスク

**低**。新規エクスポートのみ。`renderSystem` コールバックへの影響なし。

---

## 対象外とした機能

| 機能 | 理由 |
|---|---|
| Ship Status Badge (vibe-admiral) | Phase→色マッピングは vibe-admiral ドメイン固有。`SystemMessageBadge` の利用で代替可能 |
| HandoffModal (agents-familia) | マルチエージェントアーキテクチャ固有。汎用化の余地は小さい |
| TipTap 数式拡張 (agents-familia) | エディタ固有。チャット UI プリミティブではない |
| remark-issue-link | 既に synapse-chat に実装済み（`remarkIssueLink`）。重複解消済み |
| Commander Message Badge | vibe-admiral の Fleet 固有概念（Flagship/Dock）。汎用化不適切 |

---

## 移行戦略

1. 各機能を個別 issue として起票し、1 PR ずつ実装・リリースする
2. 各機能の実装後、vibe-admiral / agents-familia でインポート元を `@synapse-chat/react` に切り替え、自前実装を削除する
3. CSS は `./styles` subpath を opt-in にし、既存アプリへの影響を最小化する
4. Changeset で semver を管理する（機能追加は minor、スタイル変更は注意が必要）

---

## 子 Issue 一覧

| 機能 | Issue |
|---|---|
| CompactionBadge コンポーネント | [#21](https://github.com/mizunowanko/synapse-chat/issues/21) |
| デフォルト Markdown CSS スタイル | [#22](https://github.com/mizunowanko/synapse-chat/issues/22) |
| ConnectionStatusBadge コンポーネント | [#23](https://github.com/mizunowanko/synapse-chat/issues/23) |
| CollapsibleOutput コンポーネント | [#24](https://github.com/mizunowanko/synapse-chat/issues/24) |
| SystemMessageBadge コンポーネント | [#25](https://github.com/mizunowanko/synapse-chat/issues/25) |

---

## 参照

- [Issue #20](https://github.com/mizunowanko/synapse-chat/issues/20): この ADR の起点
- `@synapse-chat/react` 現行 API: `packages/react/src/index.ts`
- vibe-admiral 調査対象: `src/components/chat/ChatMessage.tsx`, `src/components/bridge/SystemMessageCard.tsx`, `src/components/session/SessionMessage.tsx`, `src/globals.css`
- agents-familia 調査対象: `src/components/session/SessionChat.tsx`
