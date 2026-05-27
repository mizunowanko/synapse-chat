# ADR-0002: Gemma (Ollama) を CLIAdapter として統合する

- **Status**: Proposed
- **Date**: 2026-05-27
- **Issue**: [#32](https://github.com/mizunowanko/synapse-chat/issues/32)
- **Tags**: adapter, local-llm, ollama, gemma

## Context

agents-familia でローカル LLM（Gemma / Ollama）をセッション選択肢として提供したい。

synapse-chat はすでに `CLIAdapter` 抽象（subprocess + stdin/stdout で stream-json をやり取り）を持ち、`claudeAdapter` / `geminiAdapter` が実装している。

Ollama は `POST http://localhost:11434/v1/chat/completions` の OpenAI 互換 HTTP API を提供する。当初は HTTP クライアント（`fetch` + SSE）として実装することを検討したが、以下の理由で CLIAdapter アプローチを採用する。

## Decision

**run_gemma を stream-json 出力 CLI に改修し、`gemmaAdapter` が `CLIAdapter` を実装する。**

### 採用した理由

- `CLIAdapter` / `ProcessManager` の既存コードがそのまま使える
- `claudeAdapter` と同じ起動・監視・ストリーム解析パスに乗る
- `HTTPAdapter` という新抽象を synapse-chat に持ち込まずに済む
- run_gemma 自体が Ollama HTTP の詳細を隠蔽するため、adapter 側はシンプルになる

### 却下した代替案

**HTTPAdapter 抽象の追加**: `CLIAdapter` と並列に `HTTPAdapter` インターフェースを定義し、ProcessManager をバイパスして fetch で直接 Ollama を叩く案。synapse-chat のコアアーキテクチャに新たな抽象を追加する必要があり、agents-familia 以外のユースケースが不明な段階では over-engineering と判断した。

### run_gemma の仕様変更

`~/Projects/Platform/llms/run_gemma4.sh` を以下に変更する:

- Ollama は**起動済み前提**（`ollama serve` は呼ばない）
- `-p <prompt>` または stdin からメッセージを受け取る
- Ollama SSE レスポンスを **stream-json** に変換して stdout に出力
- 終端に `{ type: "result", subtype: "success" }` を出力

### gemmaAdapter の仕様

```ts
export const gemmaAdapter: CLIAdapter = {
  command: process.env.GEMMA_CLI_PATH ?? "run_gemma4.sh",
  buildArgs(options): string[],   // model (-m gemma4-light 等)
  parseOutput(line): StreamMessage | null,
  rateLimitPatterns: [],          // ローカル実行のため不要
  retryableErrorPatterns: [],
}
```

### 対応しない機能

| 機能 | 理由 |
|------|------|
| セッション resume | Ollama はステートレス |
| コンパクション | セッション管理がないため不要 |
| tool_use | Gemma の精度が不安定、初期スコープ外 |
| rate-limit retry | ローカル実行のため不要 |
| prepareWorkspace | 不要 |

## Consequences

**正の影響:**
- synapse-chat の既存アーキテクチャを変更せずにローカル LLM を統合できる
- agents-familia は `claudeAdapter` と同じ方法で `gemmaAdapter` を使える
- Ollama / run_gemma の起動管理を synapse-chat / agents-familia の外に置けるため責務が明確

**負の影響・制約:**
- Ollama の起動は利用側の責任（agents-familia は「起動済み前提」の注記が必要）
- run_gemma が stream-json 変換レイヤーを持つため、Ollama の直接アップグレードが run_gemma の改修を要する場合がある
- tool_use 非対応のため、エージェント機能が必要なユースケースには不向き
