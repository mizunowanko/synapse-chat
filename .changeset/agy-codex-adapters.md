---
"@synapse-chat/server": minor
"@synapse-chat/core": minor
---

Add `agy` (Antigravity CLI) and `codex` (Codex CLI) adapters

Two new `CLIAdapter` implementations, both built from output measured against
the real binaries rather than assumed from Claude's shape:

- **`agyAdapter`** — targets `agy` (Antigravity CLI), *not* Google's `gemini`
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
