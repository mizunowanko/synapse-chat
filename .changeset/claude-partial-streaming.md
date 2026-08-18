---
"@synapse-chat/server": minor
"@synapse-chat/core": patch
---

feat(claude): token-level streaming via `--include-partial-messages`

`createClaudeAdapter({ stream: true })` makes the Claude adapter emit one
message per token delta instead of one per finished block, matching what the
Ollama adapter already did and what `AssistantMessage` was always documented to
carry.

The CLI emits finished `assistant` messages *in addition to* the deltas, so the
streaming parser drops the finished `text` / `thinking` blocks and keeps only
`tool_use` from them — tool input arrives as `input_json_delta` fragments that
are more fragile to reassemble than to read once, whole. Each mode ignores the
other's events, so neither can double a sentence.

`claudeAdapter` (the existing const) is unchanged.
