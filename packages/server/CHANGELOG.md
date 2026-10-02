# @mizunowanko/synapse-chat-server

## 0.1.0

### Minor Changes

- 638a224: Add `agy` (Antigravity CLI) and `codex` (Codex CLI) adapters

  Two new `CLIAdapter` implementations, both built from output measured against
  the real binaries rather than assumed from Claude's shape:

  - **`agyAdapter`** — targets `agy` (Antigravity CLI), _not_ Google's `gemini`
    CLI. Emits `--output-format stream-json`, forwards `cwd` as `--add-dir`
    (without which agy reads no files at all), resumes via `--conversation`, and
    speaks agy's own stdin turn envelope (`{"event":"user",…}`).
  - **`codexAdapter`** — targets `codex exec --json`. Maps `cwd` to `-C`,
    `autoApprove` to `--dangerously-bypass-approvals-and-sandbox`, always passes
    `--skip-git-repo-check`, and emits all options ahead of the `resume`
    subcommand as clap requires.

  Supporting changes:

  - `SessionOptions` gains an optional `model` passthrough.
  - `ProcessManager.dispatch` now forwards `cwd` into `SessionOptions`. It
    previously passed it only to `spawn()`, so no adapter could translate it into
    a workspace flag.
  - `geminiAdapter` is documented as targeting a different CLI, with no
    stream-json output and no resume support.

- 00ac090: feat(claude): token-level streaming via `--include-partial-messages`

  `createClaudeAdapter({ stream: true })` makes the Claude adapter emit one
  message per token delta instead of one per finished block, matching what the
  Ollama adapter already did and what `AssistantMessage` was always documented to
  carry.

  The CLI emits finished `assistant` messages _in addition to_ the deltas, so the
  streaming parser drops the finished `text` / `thinking` blocks and keeps only
  `tool_use` from them — tool input arrives as `input_json_delta` fragments that
  are more fragile to reassemble than to read once, whole. Each mode ignores the
  other's events, so neither can double a sentence.

  `claudeAdapter` (the existing const) is unchanged.

- eb0ef3a: feat(claude): surface `conversation_reset` as a `system` message

  `/clear` emits a `conversation_reset` line carrying only ids and a timestamp.
  It used to be dropped, which was harmless while the CLI still followed it with a
  synthetic `"(no content)"` assistant message — the trace consumers actually
  rendered. The CLI stopped emitting that, leaving `/clear` silent.

  It now parses to `{ type: "system", subtype: "conversation-reset" }`. Whether
  that draws anything is the app's call: consumers whitelist the `system` subtypes
  they can render, so nothing changes for one that does not list it.

- fd2a16b: Add `gemmaAdapter` for Ollama/Gemma local LLM support via `CLIAdapter` interface.

  `gemmaAdapter` connects to a `run_gemma4.sh` CLI wrapper that calls the Ollama
  OpenAI-compatible API and streams Claude-compatible JSON to stdout. Configure the
  binary path with `GEMMA_CLI_PATH` and model with `GEMMA_MODEL` (light/middle/heavy).

- 7057736: First release, published to GitHub Packages (#68)

  The packages are published as `@mizunowanko/synapse-chat-{core,react,server,mcp}`
  because GitHub Packages requires the npm scope to match the repository owner.
  Import paths do not change: consumers install them under the old names through an
  npm alias, e.g. `"@synapse-chat/core": "npm:@mizunowanko/synapse-chat-core@0.1.0"`.
  All four packages share one version.

- 63fbca1: `startSupervisor` adds graceful shutdown, PM worker health checks, and a restart cap.

  - `SupervisorOptions` gains `shutdownTimeout`, `healthCheckInterval`, `healthCheckTimeout`, `maxRestarts`, `onFatal`, `onTerminate`, and `installGlobalHandlers`. All optional; defaults preserve the previous behaviour (5s shutdown timeout, no health check, unbounded restarts).
  - `SupervisorHandle` exposes `stop()` as an alias for `shutdown()`. The `shutdown` sequence now SIGKILLs any child that fails to exit within `shutdownTimeout`, instead of leaving it dangling when the supervisor itself exits.
  - When `healthCheckInterval` is set, the supervisor pings the PM worker over IPC. Missed pongs (after `healthCheckTimeout`) cause a SIGKILL → restart cycle, catching hung CLI subprocesses.
  - When a child exceeds `maxRestarts`, `onFatal(label, count)` runs and the supervisor initiates its own shutdown so the embedding process can exit cleanly.

### Patch Changes

- c9bf16c: fix(server): parse Claude's `tool_result` out of the wrapping `user` turn

  Claude delivers every tool result as a `user` turn — the API's own convention,
  since results are fed back as user-role content:

  ```json
  {
    "type": "user",
    "message": {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_…",
          "content": "1\thello"
        }
      ]
    }
  }
  ```

  `parseStreamMessage` had no `case "user"`, so the whole turn was dropped and
  Claude sessions rendered tool calls that never visibly completed. agy / Codex
  were unaffected: their adapters build `StreamMessage` directly and never reach
  this parser.

  Only `tool_result` blocks are lifted out. A `user` turn also carries the
  operator's own prompt, which the client already appended when it sent it, so
  passing that through would draw every question twice.

  `is_error: true` rides along as `meta.isError`, mirroring how the Codex adapter
  carries `exitCode`. Non-text result blocks (an image `Read`) yield a
  `tool_result` with no `content` rather than a base64 dump.

- ed50bf9: Drop `system:thinking_tokens` progress events in the stream parser. Claude CLI emits these extended-thinking progress notifications roughly every second, and they were previously passing the `system` message filter — flooding chat logs, DB storage, and frontend broadcasts. The token total remains available in the `result` message's `usage` block, so cost accounting is unaffected.
- 0fe467a: fix(claude): keep replies that arrive without deltas

  Partial mode dropped every finished `text` / `thinking` block on the assumption
  that deltas always came first. Locally synthesised replies — `/clear` and
  friends, answered by the CLI itself with `model: "<synthetic>"` — emit no
  `stream_event` at all, so dropping their finished message deleted the only copy
  and left consumers waiting for a reply that never came.

  `createStreamMessageParser()` conditions the suppression on an observed fact
  instead: was a delta actually seen for the message now finishing. The flag
  resets at `message_start` and `result`, never on a finished message — one
  `message_start` yields several finished `assistant` lines and resetting on the
  first would double the body.
