/**
 * Where each provider looks for its handout. This is the only module here that
 * knows a provider exists; everything else operates on the briefing.
 *
 * The layouts below are measured, not guessed (Claude Code 2.1.212 / agy
 * 1.1.27 / Codex 0.153.4), and include the two counter-intuitive results:
 *
 *  - **agy reads `AGENTS.md`, not `GEMINI.md`.** So agy and Codex share one
 *    instruction file, and per-provider wording is unrepresentable there.
 *  - **Codex reads `.agents/skills/` as well as `.codex/skills/`.** Skills are
 *    therefore handed out once, to `.agents/skills/`. Writing both would give
 *    Codex every skill twice.
 */

import type { LayoutName } from "./types.js";

export interface Layout {
  name: LayoutName;
  /** Root instruction file. `claude` gets its own; `agents` and `codex` share one. */
  instructionFile: string;
  /** Directory holding `<name>/SKILL.md`. */
  skillDir: string;
  /** Directory holding one file per subagent. */
  subagentDir: string;
  /** `markdown` → `<name>.md` with YAML frontmatter; `toml` → `<name>.toml`. */
  subagentFormat: "markdown" | "toml";
  /**
   * Where this provider *used* to keep always-on rules, for `collect()` to pick
   * up when bootstrapping. Nothing is handed out here any more — rules are
   * folded into the instruction file (see `hand-out.ts`). Codex never had such
   * a directory at all.
   */
  legacyRulesDir?: string;
}

export const LAYOUTS: Record<LayoutName, Layout> = {
  claude: {
    name: "claude",
    instructionFile: "CLAUDE.md",
    skillDir: ".claude/skills",
    subagentDir: ".claude/agents",
    subagentFormat: "markdown",
    legacyRulesDir: ".claude/rules",
  },
  agents: {
    name: "agents",
    instructionFile: "AGENTS.md",
    skillDir: ".agents/skills",
    subagentDir: ".agents/agents",
    subagentFormat: "markdown",
    legacyRulesDir: ".agents/rules",
  },
  codex: {
    name: "codex",
    instructionFile: "AGENTS.md",
    skillDir: ".agents/skills",
    subagentDir: ".codex/agents",
    subagentFormat: "toml",
  },
};
