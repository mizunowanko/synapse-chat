---
"@synapse-chat/server": minor
---

Add `gemmaAdapter` for Ollama/Gemma local LLM support via `CLIAdapter` interface.

`gemmaAdapter` connects to a `run_gemma4.sh` CLI wrapper that calls the Ollama
OpenAI-compatible API and streams Claude-compatible JSON to stdout. Configure the
binary path with `GEMMA_CLI_PATH` and model with `GEMMA_MODEL` (light/middle/heavy).
