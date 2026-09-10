/**
 * Where each provider looks. This is the only module in `agent-spec/` that
 * knows a provider exists; everything else operates on the spec.
 *
 * The layout below is the measured one from issue #50 (Claude Code 2.1.212 /
 * agy 1.1.27 / Codex 0.153.4), including the two counter-intuitive results:
 *
 *  - **agy reads `AGENTS.md`, not `GEMINI.md`.** So agy and Codex share one
 *    instruction file, and per-provider wording is unrepresentable there.
 *  - **Codex reads `.agents/skills/` as well as `.codex/skills/`.** Skills are
 *    therefore emitted once, to `.agents/skills/`. Writing both would hand
 *    Codex every skill twice.
 */

import type { LayoutName } from "./types.js";

export interface Layout {
  target: LayoutName;
  /** Root instruction file. `claude` gets its own; `agents` and `codex` share one. */
  instructionFile: string;
  /** Directory holding `<name>/SKILL.md`. */
  skillDir: string;
  /** Directory holding one file per subagent. */
  subagentDir: string;
  /** `markdown` → `<name>.md` with YAML frontmatter; `toml` → `<name>.toml`. */
  subagentFormat: "markdown" | "toml";
  /**
   * Where this provider *used* to keep always-on rules, for `importFrom` to
   * pick up during migration. Nothing is rendered here any more: rules are
   * folded into the instruction file (see `render.ts`). Codex has no such
   * directory at all.
   */
  legacyRulesDir?: string;
}

export const LAYOUTS: Record<LayoutName, Layout> = {
  claude: {
    target: "claude",
    instructionFile: "CLAUDE.md",
    skillDir: ".claude/skills",
    subagentDir: ".claude/agents",
    subagentFormat: "markdown",
    legacyRulesDir: ".claude/rules",
  },
  agents: {
    target: "agents",
    instructionFile: "AGENTS.md",
    skillDir: ".agents/skills",
    subagentDir: ".agents/agents",
    subagentFormat: "markdown",
    legacyRulesDir: ".agents/rules",
  },
  codex: {
    target: "codex",
    instructionFile: "AGENTS.md",
    skillDir: ".agents/skills",
    subagentDir: ".codex/agents",
    subagentFormat: "toml",
  },
};
