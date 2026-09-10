---
"@synapse-chat/core": minor
---

feat(core): Agent Briefing — one set of instructions, handed out to three providers

`@synapse-chat/core/briefing` holds a **Briefing**: a provider-neutral statement
of an agent's instructions (sections, skills, subagents, rules). `handOut()`
copies it into the shape each provider expects — `CLAUDE.md` for Claude Code,
`AGENTS.md` for agy *and* Codex, plus `.claude/`, `.agents/` and `.codex/`
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
