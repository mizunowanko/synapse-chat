/**
 * issue #50: the Agent Spec — one abstract description of an agent's
 * instructions, projected onto every provider we support.
 *
 * The spec is the SSoT. `CLAUDE.md`, `AGENTS.md`, `.claude/skills/…`,
 * `.agents/skills/…`, `.codex/agents/*.toml` are all *derived*: `handOut()`
 * produces them, and nothing in this module reads them back except
 * `importFrom()`, which exists only to bootstrap the migration.
 *
 * **The prose is provider-neutral by construction.** The measured layout (issue
 * #50) has agy and Codex sharing a single `AGENTS.md`, so "say `apply_patch` to
 * Codex but `write_file` to agy" is not even expressible — one file, two
 * readers. That is exactly the property we want: a spawned agent cannot notice
 * which adapter rendered it, because there is no per-provider wording to notice.
 * Provider-specific knobs therefore live in {@link ProviderFrontmatter}, which
 * is harness configuration (frontmatter / TOML keys), never body text.
 */

/** The three projections. `agents` is agy; Codex shares its instruction file. */
export type LayoutName = "claude" | "agents" | "codex";

export const LAYOUT_NAMES: readonly LayoutName[] = ["claude", "agents", "codex"];

export function isLayoutName(value: string): value is LayoutName {
  return (LAYOUT_NAMES as readonly string[]).includes(value);
}

/**
 * Per-provider frontmatter escape hatch (issue #50 「決めること」3). Merged into
 * the rendered skill/subagent header for that target only — e.g.
 * `{ claude: { "allowed-tools": "Read, Grep" } }` or `{ claude: { context: "fork" } }`.
 *
 * Body text is deliberately not overridable here. These keys are read by the
 * harness, not by the model, so they cannot leak the adapter into the prose.
 */
export type ProviderFrontmatter = Partial<Record<LayoutName, Record<string, unknown>>>;

/**
 * A `## ` chunk of the instruction file. `heading` is the identity — renaming a
 * heading reads as delete + add. Accepted for now: change detection and reverse
 * projection are a separate issue, and a synthetic stable id we cannot yet
 * exercise would be untested weight.
 */
export interface BriefingSection {
  heading: string;
  /** Verbatim Markdown. Carried through unchanged; may contain `###`, fences, tables. */
  body: string;
}

export interface BriefingSkill {
  name: string;
  description: string;
  body: string;
  providerFrontmatter?: ProviderFrontmatter;
}

export interface BriefingSubagent {
  name: string;
  description: string;
  /**
   * The subagent's own prompt. Rendered as the Markdown body for Claude/agy and
   * as `developer_instructions` for Codex.
   */
  instructions: string;
  providerFrontmatter?: ProviderFrontmatter;
}

/**
 * An always-on rule. Codex has no rules container at all, so rules are folded
 * into the instruction file for every target (see `render.ts`).
 */
export interface BriefingRule {
  name: string;
  body: string;
}

export interface Briefing {
  /** Directory / identifier name, e.g. `Amanatsu`. */
  name: string;
  /** Human-facing name used as the `# ` title; defaults to {@link Briefing.name}. */
  displayName?: string;
  /** One or two lines placed directly under the title, before the first `## `. */
  role?: string;
  sections: BriefingSection[];
  skills: BriefingSkill[];
  subagents: BriefingSubagent[];
  rules: BriefingRule[];
}

/** Render output: repo-relative path → file content. */
export type HandoutFiles = Record<string, string>;
