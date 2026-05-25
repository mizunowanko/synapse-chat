# Design Doc: synapse-chat フィーチャー統合

> **ステータス**: Draft  
> **関連 ADR**: [ADR-0001](../adr/0001-synapse-chat-feature-consolidation.md)  
> **関連 Issue**: [#20](https://github.com/mizunowanko/synapse-chat/issues/20)

---

## 1. 背景と目的

synapse-chat のスコープ定義:「ビジネスロジックを含まない Claude/Gemini CLI のラッパー＋チャット UI 用コンポーネント」

vibe-admiral・agents-familia はいずれも `@synapse-chat/*` の重いユーザーだが、チャット UI の汎用プリミティブを各自で自前実装している。本 design doc では、これらを synapse-chat へ統合するための詳細アーキテクチャと移行計画を記述する。

### 1.1 現状のコスト

| 問題 | 影響 |
|---|---|
| 同一ロジックの二重メンテナンス | バグ修正・改善が片側にしか反映されないリスク |
| 消費側への CSS・コンポーネント転嫁 | 新規アプリが同じ車輪を再実装する必要がある |
| 非一貫な UX | アプリ間でコンパクション表示・バッジスタイルが微妙に異なる |

---

## 2. 現状実装の詳細分析

### 2.1 機能 1: コンパクション可視化

#### vibe-admiral の実装

**ファイル**: `src/components/chat/ChatMessage.tsx` (L146–163)

```tsx
// vibe-admiral の実装
if (message.content?.includes("Compacting context")) {
  return (
    <div className="flex justify-center my-2">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-100 text-violet-700 text-xs font-medium">
        <span className="animate-pulse w-2 h-2 rounded-full bg-violet-400" />
        Compacting context...
      </div>
    </div>
  );
}
```

**課題**:
- `content?.includes()` による文字列一致は脆弱（Claude CLI の出力フォーマット変更で壊れる）
- `subtype: "compacting"` という構造化フィールドがあるが使われていない
- スタイルが Tailwind クラスにハードコードされ、テーマ変更不可

#### agents-familia の実装

コンパクション可視化は**未実装**。`parseStreamMessage()` の結果をそのまま流しているが表示上の対処なし。

#### 調査から判明した gap

`@synapse-chat/server` の `parseStreamMessage()` は compaction メッセージを `{ type: "system", subtype: "compacting" }` として正しく parse している。UI レイヤーだけが欠落している。

---

### 2.2 機能 2: Markdown デフォルトスタイル

#### vibe-admiral の実装

**ファイル**: `src/globals.css` (L84–220, 約 136 行)

```css
/* vibe-admiral の実装（抜粋） */
.bridge-markdown table,
.synapse-chat-markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.75rem 0;
}
.bridge-markdown th,
.bridge-markdown td,
.synapse-chat-markdown th,
.synapse-chat-markdown td {
  border: 1px solid var(--border);
  padding: 0.4rem 0.75rem;
  text-align: left;
}
/* ... code, blockquote, h1-h6, ul/ol, etc. */
```

**適用箇所**:
- `ChatMessage.tsx` L203: `.bridge-markdown`（dispatch/escort ログ用）
- `ChatMessage.tsx` L230: `.synapse-chat-markdown`（アシスタントメッセージ用）

**課題**:
- 2 つのほぼ同一の CSS クラスが存在（`.bridge-markdown` と `.synapse-chat-markdown`）
- `var(--border)` など CSS Custom Properties を使っているが synapse-chat 側には定義がない
- `@synapse-chat/react` を使う新規アプリは必ずこの CSS を自前で書く必要がある

#### agents-familia の実装

**ファイル**: `src/index.css`（グローバル CSS）

agents-familia は独自のグローバル CSS に react-markdown 用スタイルを持っているが、vibe-admiral とは微妙に異なる定義になっている。テーブル罫線の太さや padding が異なる。

---

### 2.3 機能 3: 接続・レート制限状態バッジ

#### vibe-admiral の実装

**ファイル**: `src/components/session/SessionMessage.tsx`

```tsx
// Rate limit badge (L108-116)
if (message.subtype === "rate-limit") {
  return (
    <div className="flex justify-center my-1">
      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs">
        Rate limit — retrying...
      </span>
    </div>
  );
}

// Connection status (L85-105)
if (message.subtype === "connected" || message.subtype === "disconnected") {
  const isConnected = message.subtype === "connected";
  return (
    <div className="flex justify-center my-1">
      <span className={`px-2 py-0.5 rounded-full text-xs ${
        isConnected ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
      }`}>
        {isConnected ? "connected" : message.content ?? "disconnected"}
      </span>
    </div>
  );
}
```

**課題**:
- `useConnectionStatus()` フックと UI バッジが分離しており、フック使用側が毎回バッジをゼロから書く
- `rate-limit` / `connected` / `disconnected` subtype の存在を各アプリが個別に知る必要がある

#### agents-familia の実装

接続状態バッジは実装済みだが独自スタイル。レート制限バッジは未実装（エラー時はコンソールのみ）。

---

### 2.4 機能 4: コラプシブル出力カード

#### vibe-admiral の実装

**ファイル**: `src/components/chat/ChatMessage.tsx` (L73-103)

```tsx
function RequestResultCard({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 3;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-mono text-slate-700">
      <pre className="whitespace-pre-wrap overflow-auto">
        {expanded ? content : lines.slice(0, 3).join("\n")}
      </pre>
      {isLong && (
        <button onClick={() => setExpanded(!expanded)} className="...">
          {expanded ? "show less" : `show ${lines.length - 3} more lines`}
        </button>
      )}
    </div>
  );
}
```

**課題**:
- `[Engine]` プレフィックスにハードコードされており汎用化されていない
- `maxLines=3` がハードコード
- 現行の `ToolUseGroup` はグループ折りたたみはするが、**テキストブロック自体**の長さ制御は持っていない

#### agents-familia の実装

長い tool_result の折りたたみは**未実装**。長い出力はそのまま全表示される。

---

### 2.5 機能 5: システム通知バッジ汎化

#### vibe-admiral の実装

**ファイル**: `src/components/bridge/SystemMessageCard.tsx` (約 150 行)

```tsx
const VARIANT_MAP: Record<string, { label: string; colorClass: string; icon?: string }> = {
  "gate-check-request": { label: "Gate Check", colorClass: "bg-indigo-100 text-indigo-800", icon: "🔍" },
  "gate-skip":          { label: "Gate Skip",  colorClass: "bg-green-100 text-green-800",  icon: "✅" },
  "pr-review-request":  { label: "PR Review",  colorClass: "bg-sky-100 text-sky-800",      icon: "📋" },
  "lookout-alert":      { label: "Alert",      colorClass: "bg-red-100 text-red-800",      icon: "🚨" },
};

export function SystemMessageCard({ message }: { message: StreamMessage }) {
  const variant = VARIANT_MAP[message.subtype ?? ""];
  if (!variant) return null;
  // ... バッジのレンダリング
}
```

**課題**:
- `VARIANT_MAP` が vibe-admiral 固有の subtype にハードコード
- バッジ UI（pill スタイル、アイコン + ラベル + severity badge）は完全に汎用だが再利用不可
- `renderSystem` prop があれば自前実装できるが、バッジの基盤 UI を毎回書くのは冗長

#### agents-familia の実装

システム通知バッジは未実装。`renderSystem` を使って独自 JSX を書いている。

---

## 3. 移行アーキテクチャ案

### 3.1 全体像

```
@synapse-chat/react
├── components/
│   ├── ChatMessage.tsx          (既存 — compaction/status 分岐を追加)
│   ├── CompactionBadge.tsx      (新規)
│   ├── ConnectionStatusBadge.tsx (新規)
│   ├── CollapsibleOutput.tsx    (新規)
│   ├── SystemMessageBadge.tsx   (新規)
│   └── ToolUseGroup.tsx         (既存 — maxOutputLines prop を追加)
├── styles/
│   └── chat-message.css         (新規 — デフォルト Markdown CSS)
└── index.ts                     (新規コンポーネントを export に追加)
```

### 3.2 コンポーネント設計詳細

#### 3.2.1 `CompactionBadge`

```typescript
// packages/react/src/components/CompactionBadge.tsx

export interface CompactionBadgeProps {
  /** 追加 CSS クラス */
  className?: string;
}

/**
 * Claude CLI のコンパクションイベントを視覚化するバッジ。
 * ChatMessage が subtype: "compacting" を検出した際に自動的に使用する。
 * renderSystem prop で上書き可能。
 */
export function CompactionBadge({ className }: CompactionBadgeProps): ReactElement {
  return (
    <div className={cn("flex justify-center my-2", className)}>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-100 text-violet-700 text-xs font-medium">
        <span className="animate-pulse w-2 h-2 rounded-full bg-violet-400" />
        Compacting context...
      </div>
    </div>
  );
}
```

**`ChatMessage` への統合**:

```typescript
// ChatMessage.tsx 内の変更箇所
if (message.type === "system" && message.subtype === "compacting") {
  if (renderSystem) {
    const custom = renderSystem(message);
    if (custom !== undefined) return <>{custom}</>;
  }
  return <CompactionBadge />;
}
```

`subtype` フィールドによる構造化検出に切り替えることで、文字列マッチングの脆弱性を解消する。

#### 3.2.2 `ConnectionStatusBadge`

```typescript
// packages/react/src/components/ConnectionStatusBadge.tsx

export type ConnectionStatusBadgeVariant = "default" | "compact";

export interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  isRateLimited?: boolean;
  className?: string;
  variant?: ConnectionStatusBadgeVariant;
}

export function ConnectionStatusBadge({
  status,
  isRateLimited,
  className,
  variant = "default",
}: ConnectionStatusBadgeProps): ReactElement | null {
  if (status === "connected" && !isRateLimited) return null;

  if (isRateLimited) {
    return (
      <StatusPill className={cn("bg-amber-100 text-amber-700", className)} variant={variant}>
        Rate limit — retrying...
      </StatusPill>
    );
  }

  if (status === "reconnecting") {
    return (
      <StatusPill className={cn("bg-yellow-100 text-yellow-700", className)} variant={variant}>
        Reconnecting...
      </StatusPill>
    );
  }

  // disconnected
  return (
    <StatusPill className={cn("bg-red-100 text-red-700", className)} variant={variant}>
      Disconnected
    </StatusPill>
  );
}
```

#### 3.2.3 `CollapsibleOutput`

```typescript
// packages/react/src/components/CollapsibleOutput.tsx

export interface CollapsibleOutputProps {
  content: string;
  /** 折りたたむ行数のしきい値 (デフォルト: 3) */
  maxLines?: number;
  /** 折りたたみ時に表示するラベル (省略時: 最初の行) */
  label?: string;
  className?: string;
  defaultExpanded?: boolean;
}

export function CollapsibleOutput({
  content,
  maxLines = 3,
  label,
  className,
  defaultExpanded = false,
}: CollapsibleOutputProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const lines = content.split("\n");
  const isLong = lines.length > maxLines;
  const displayContent = isLong && !expanded
    ? lines.slice(0, maxLines).join("\n")
    : content;

  return (
    <div className={cn("rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-mono text-slate-700", className)}>
      <pre className="whitespace-pre-wrap overflow-auto">{displayContent}</pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-slate-500 hover:text-slate-700 text-xs underline"
        >
          {expanded ? "show less" : `show ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}
```

**`ToolUseGroup` への統合**:

```typescript
// ToolUseGroup.tsx の変更
export interface ToolUseGroupProps {
  group: ToolUseGroupItem;
  context?: ChatMessageContext;
  /** tool_result を折りたたむ行数 (省略時: 折りたたみなし = 後方互換) */
  maxOutputLines?: number;
}
```

#### 3.2.4 `SystemMessageBadge`

```typescript
// packages/react/src/components/SystemMessageBadge.tsx

export interface SystemMessageVariantConfig {
  label: string;
  icon?: string;
  colorClass?: string;
}

export interface SystemMessageBadgeProps {
  subtype: string;
  variants: Record<string, SystemMessageVariantConfig>;
  fallback?: ReactNode;
  className?: string;
  message?: StreamMessage;
}

export function SystemMessageBadge({
  subtype,
  variants,
  fallback = null,
  className,
  message,
}: SystemMessageBadgeProps): ReactElement | null {
  const config = variants[subtype];
  if (!config) return <>{fallback}</>;

  return (
    <div className={cn("flex justify-center my-2", className)}>
      <span className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium",
        config.colorClass ?? "bg-slate-100 text-slate-700"
      )}>
        {config.icon && <span>{config.icon}</span>}
        {config.label}
      </span>
    </div>
  );
}
```

#### 3.2.5 Markdown デフォルト CSS

**ファイル**: `packages/react/src/styles/chat-message.css`

```css
/* @synapse-chat/react デフォルト Markdown スタイル */

:root {
  --synapse-chat-border: #e2e8f0;
  --synapse-chat-code-bg: #f8fafc;
  --synapse-chat-muted: #94a3b8;
  --synapse-chat-heading-color: inherit;
}

.synapse-chat-markdown {
  line-height: 1.6;
}

/* Tables */
.synapse-chat-markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.75rem 0;
  font-size: 0.875em;
}
.synapse-chat-markdown th,
.synapse-chat-markdown td {
  border: 1px solid var(--synapse-chat-border);
  padding: 0.4rem 0.75rem;
  text-align: left;
}
.synapse-chat-markdown th {
  background: var(--synapse-chat-code-bg);
  font-weight: 600;
}

/* Code */
.synapse-chat-markdown code {
  background: var(--synapse-chat-code-bg);
  border-radius: 3px;
  font-size: 0.875em;
  padding: 0.15em 0.35em;
}
.synapse-chat-markdown pre {
  background: var(--synapse-chat-code-bg);
  border-radius: 6px;
  overflow-x: auto;
  padding: 0.75rem 1rem;
  margin: 0.75rem 0;
}
.synapse-chat-markdown pre code {
  background: transparent;
  padding: 0;
}

/* Headings */
.synapse-chat-markdown h1,
.synapse-chat-markdown h2,
.synapse-chat-markdown h3,
.synapse-chat-markdown h4 {
  color: var(--synapse-chat-heading-color);
  font-weight: 600;
  margin: 1rem 0 0.5rem;
  line-height: 1.3;
}

/* Lists */
.synapse-chat-markdown ul,
.synapse-chat-markdown ol {
  margin: 0.5rem 0;
  padding-left: 1.5rem;
}
.synapse-chat-markdown li {
  margin: 0.2rem 0;
}

/* Blockquote */
.synapse-chat-markdown blockquote {
  border-left: 3px solid var(--synapse-chat-border);
  color: var(--synapse-chat-muted);
  margin: 0.75rem 0;
  padding: 0.25rem 0 0.25rem 1rem;
}
```

**exports の追加** (`packages/react/package.json`):

```json
{
  "exports": {
    ".": { ... },
    "./styles": "./src/styles/chat-message.css"
  }
}
```

消費側: `import "@synapse-chat/react/styles";`

---

## 4. インターフェース設計サマリー

### 4.1 新規エクスポート一覧

```typescript
// packages/react/src/index.ts への追加

// 新規コンポーネント
export { CompactionBadge }         from "./components/CompactionBadge";
export type { CompactionBadgeProps } from "./components/CompactionBadge";

export { ConnectionStatusBadge }   from "./components/ConnectionStatusBadge";
export type { ConnectionStatusBadgeProps, ConnectionStatusBadgeVariant } from "./components/ConnectionStatusBadge";

export { CollapsibleOutput }       from "./components/CollapsibleOutput";
export type { CollapsibleOutputProps } from "./components/CollapsibleOutput";

export { SystemMessageBadge }      from "./components/SystemMessageBadge";
export type { SystemMessageBadgeProps, SystemMessageVariantConfig } from "./components/SystemMessageBadge";
```

### 4.2 既存 API への変更

| コンポーネント/フック | 変更内容 | Breaking |
|---|---|---|
| `ChatMessage` | `subtype: "compacting"` 分岐追加 | No |
| `ChatMessage` | `subtype: "rate-limit"` / `"connected"` / `"disconnected"` 分岐追加 | No |
| `ToolUseGroup` | `maxOutputLines?: number` prop 追加 | No |
| `package.json` | `"./styles"` subpath export 追加 | No |

### 4.3 型依存関係

```
CompactionBadge         → (standalone)
ConnectionStatusBadge   → ConnectionStatus (既存)
CollapsibleOutput       → (standalone)
SystemMessageBadge      → StreamMessage (既存)
```

---

## 5. 移行ステップと依存関係

### 5.1 実装順序（推奨）

```
Phase A (独立実装):
  #21 CompactionBadge     ─────────────────────────────────┐
  #22 Markdown CSS        ─────────────────────────────────┤ 順不同で実装可
  #23 ConnectionStatusBadge ───────────────────────────────┤
  #24 CollapsibleOutput   ─────────────────────────────────┘

Phase B (上記完了後):
  #25 SystemMessageBadge  ─── Phase A の完了を待たず実装可

Phase C (synapse-chat リリース後):
  vibe-admiral 移行         ─── 各 issue の実装完了後に個別 PR
  agents-familia 移行       ─── 同上
```

### 5.2 vibe-admiral 移行時の削除対象

| 現在のファイル | 移行後の対応 |
|---|---|
| `ChatMessage.tsx` L146-163 (compaction) | `<CompactionBadge />` に置き換え |
| `globals.css` L84-220 (markdown CSS) | `import "@synapse-chat/react/styles"` に置き換え |
| `SessionMessage.tsx` rate-limit/status バッジ | `<ConnectionStatusBadge />` に置き換え |
| `ChatMessage.tsx` L73-103 (RequestResultCard) | `<CollapsibleOutput />` に置き換え |
| `SystemMessageCard.tsx` | `<SystemMessageBadge variants={...} />` に置き換え |

### 5.3 agents-familia 移行時の対応

| 現在の状態 | 移行後の対応 |
|---|---|
| コンパクション未対応 | `<CompactionBadge />` を追加 |
| 独自 Markdown CSS | `import "@synapse-chat/react/styles"` に統一 |
| レート制限バッジ未実装 | `<ConnectionStatusBadge />` を追加 |
| 長い tool_result 全表示 | `<ToolUseGroup maxOutputLines={10} />` を検討 |

---

## 6. リスク・懸念点

### 6.1 Markdown CSS の視覚的変化

**リスク度**: 中

`import "@synapse-chat/react/styles"` は opt-in だが、既存アプリが独自 CSS と併用した場合に specificity conflict が起きる可能性がある。

**緩和策**:
- CSS Custom Properties（`--synapse-chat-*`）をすべての色・サイズに使用し、上書き容易にする
- `.synapse-chat-markdown` クラスをスコープとして使用し、グローバル汚染を防ぐ
- example app でのスクリーンショット比較テストを CI に追加する

### 6.2 `ChatMessage` の自動分岐追加

**リスク度**: 低

`subtype: "compacting"` 検出の追加は既存の `renderSystem` prop を尊重するため後方互換。ただし、既存アプリが `renderSystem` をオーバーライドせず compaction メッセージを素のテキストとして表示していた場合、表示が変わる（素のテキスト → アニメーションバッジ）。

**緩和策**:
- `renderSystem` prop を使えば従来の表示を維持できることを CHANGELOG に明記する

### 6.3 Tailwind 依存

**リスク度**: 低

新コンポーネントは Tailwind クラスを使用する。Tailwind 未使用の消費側では CSS が適用されない。

**緩和策**:
- `CollapsibleOutput` のインタラクティブ要素（ボタン）はインラインスタイルまたは CSS modules で提供し、最低限の動作を保証する
- ドキュメントに「Tailwind v3+ 推奨」を明記する

### 6.4 Changeset 管理

各 issue は独立した minor リリースとなる。5 機能を連続リリースすることで `@synapse-chat/react` のバージョンが短期間で大きく上がる可能性がある。

**緩和策**:
- issue #21〜#25 を同一マイルストーンにグループ化し、可能であれば 1 リリースにまとめる（v0.X.0 → v0.(X+1).0 で 5 機能一括）
- Changeset の `minor` バンプは 1 回にまとめる

---

## 7. 非機能要件

| 項目 | 要件 |
|---|---|
| バンドルサイズ | 各コンポーネントは tree-shaking 可能。未使用コンポーネントは bundle に含まれない |
| SSR 互換性 | `useState` / `useEffect` 使用コンポーネントは CSR 前提。SSR 用途では dynamic import 推奨 |
| React バージョン | React 18+ 対応（React 19 も対象） |
| アクセシビリティ | `CollapsibleOutput` のトグルボタンには `aria-expanded` を付与する |
| TypeScript | `strict: true` 環境で型チェック pass |

---

## 8. 参照

- [ADR-0001](../adr/0001-synapse-chat-feature-consolidation.md)
- [Issue #20](https://github.com/mizunowanko/synapse-chat/issues/20): この design doc の起点
- 子 Issues: [#21](https://github.com/mizunowanko/synapse-chat/issues/21), [#22](https://github.com/mizunowanko/synapse-chat/issues/22), [#23](https://github.com/mizunowanko/synapse-chat/issues/23), [#24](https://github.com/mizunowanko/synapse-chat/issues/24), [#25](https://github.com/mizunowanko/synapse-chat/issues/25)
- `@synapse-chat/react` 現行 API: [`packages/react/src/index.ts`](../../packages/react/src/index.ts)
- `@synapse-chat/server` parse: [`packages/server/src/parse.ts`](../../packages/server/src/parse.ts)
