---
"@synapse-chat/react": minor
---

`CollapsibleThinking` / `ThinkingMessage` no longer auto-collapse short thinking once generation completes. Thinking at or below `autoCollapseThreshold` characters (default 300, exported as `DEFAULT_THINKING_AUTO_COLLAPSE_THRESHOLD`) stays expanded so one-line progress notes remain readable; longer thinking (e.g. Gemma via Ollama) still collapses as before. A manual toggle still overrides the automatic state.
