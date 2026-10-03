# @mizunowanko/synapse-chat-core

## 0.3.0

### Minor Changes

- core/briefing: `collectInstructions()` / `handOutInstructionFiles()` を足す。指示ファイル（`CLAUDE.md` / `AGENTS.md`）だけを回収・配布し、skill / subagent の Handout には触れない。skill を MCP（`@synapse-chat/mcp/skills`）で配るアプリ向け。

## 0.2.0

## 0.1.0

### Minor Changes

- 4174499: feat(core): Agent Briefing — one set of instructions, handed out to three providers

  `@synapse-chat/core/briefing` holds a **Briefing**: a provider-neutral statement
  of an agent's instructions (sections, skills, subagents, rules). `handOut()`
  copies it into the shape each provider expects — `CLAUDE.md` for Claude Code,
  `AGENTS.md` for agy _and_ Codex, plus `.claude/`, `.agents/` and `.codex/`
  directories — and `collect()` reads write-ins back out of those copies so an
  edit made in one reaches all of them.

  The instruction file is byte-identical across providers, which is the load-bearing
  property: agy and Codex share `AGENTS.md`, so per-provider wording is not even
  expressible, and a spawned agent has no way to notice which copy it was given.

  Generated files carry a **fingerprint**; a file that no longer hashes to its own
  is **marked-up** and is never handed out over. `detectMarkUps()` reports those.
  The same `collect()` call bootstraps a directory that was never handed out —
  files without a fingerprint read as new — so migration needs no separate import.

  Values live at `@synapse-chat/core/briefing` because they touch `node:fs` and
  `node:crypto`; the package root re-exports the types only, so browser bundles are
  unaffected. See [docs/agent-briefing.md](../docs/agent-briefing.md).

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

- 6b545ec: fix(core/briefing): `collect()` takes out skills and subagents whose handout was deleted

  A skill deleted from `.claude/skills/` used to stay in the Briefing forever:
  a missing handout read the same as an unedited one. `collect()` now takes the
  entry out — but **only with proof on disk that it was handed out**: some
  handout in the same directory still carries a fingerprint, and another layout
  still has the entry's handout. A provider that was never handed out to, a
  hand-written directory mid-migration, an absent directory, or an entry no
  layout has a handout for keeps every entry, as before.

  What was taken out is reported in the new `CollectResult.removed`
  (`{ kind, name, path }[]`), so the caller can detect a deletion that conflicts
  with a write-in elsewhere and tidy up the other layouts' handouts — `handOut()`
  still cannot express a deletion.

- ad44d85: feat: add `@synapse-chat/mcp` — declarative MCP tool proxies + CLI settings generators

  - New package `@synapse-chat/mcp` exposes a small surface for turning an application's Backend HTTP API into MCP tools that local CLI agents (Claude Code, Gemini CLI) can call directly.
  - `defineHttpTool({ name, method, path, inputSchema, confirmation? })` authoring helper with build-time validation.
  - `createMcpServer({ name, version, tools, baseUrl })` wires a set of tools into an MCP stdio server in one call (exposes the underlying `Server` handle so callers can attach custom transports / additional handlers).
  - `callHttpTool()` lower-level helper: substitutes `{placeholder}` path params, serialises remaining args as query (GET/HEAD/DELETE) or JSON body (POST/PUT/PATCH), maps 4xx/5xx responses to MCP `isError` tool results.
  - Standardised `confirmation: true` guard for destructive actions: the helper auto-injects `confirmed: boolean` into the input schema and short-circuits with an MCP error if the LLM invokes the tool without explicit confirmation.
  - Settings-file generators for Claude Code (`.mcp.json` + `.claude/settings.local.json`) and Gemini CLI (`.gemini/settings.json`). `prepareMcpWorkspace(cwd, { cli, mcpServers })` merges into existing files so user settings are preserved.
  - `deriveAllowedTools({ cli, servers })` produces CLI-specific allow-list entries (`mcp__<server>__<tool>` for Claude, `<server>__<tool>` for Gemini). Fully compatible with the existing `allowedTools` / `disallowedTools` flow in `@synapse-chat/server`.
  - `@synapse-chat/core` gains an optional `prepareWorkspace?(cwd): Promise<void>` hook on `CLIAdapter` so custom spawners can surface a uniform pre-spawn step. The built-in `ProcessManager` is unchanged; existing adapters keep working without modification.

- 7057736: First release, published to GitHub Packages (#68)

  The packages are published as `@mizunowanko/synapse-chat-{core,react,server,mcp}`
  because GitHub Packages requires the npm scope to match the repository owner.
  Import paths do not change: consumers install them under the old names through an
  npm alias, e.g. `"@synapse-chat/core": "npm:@mizunowanko/synapse-chat-core@0.1.0"`.
  All four packages share one version.

- 1a5fade: feat: add Chat Storage Adapter pattern for history persistence

  - `@synapse-chat/core` exports a new `ChatStorage<T>` interface (`save` / `load` / `clear`).
  - `@synapse-chat/react/storage` ships two opt-in adapters: `createLocalStorageAdapter` and `createIndexedDBAdapter`. Both are SSR-safe (no-op when the underlying browser API is missing).
  - `useChat` accepts `storage` + `sessionId` options, hydrates on mount, debounces writes, and exposes `isHydrating`. Without those options the hook behaves exactly as before.

### Patch Changes

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
