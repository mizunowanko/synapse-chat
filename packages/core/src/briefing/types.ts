/**
 * issue #50: the **Briefing** — one provider-neutral statement of an agent's
 * instructions, handed out to every provider we support.
 *
 * Think of a teacher with one set of notes and a class to hand copies to.
 * `CLAUDE.md`, `AGENTS.md`, `.claude/skills/…`, `.agents/skills/…`,
 * `.codex/agents/*.toml` are all **handouts** — copies of the briefing in the
 * shape each provider expects. `handOut()` makes them; `collect()` takes them
 * back in once somebody has written on one.
 *
 * **The prose is provider-neutral by construction.** The measured layout has
 * agy and Codex sharing a single `AGENTS.md`, so "say `apply_patch` to Codex
 * but `write_file` to agy" is not even expressible — one file, two readers.
 * That is exactly the property we want, and it is the vocabulary's whole point:
 * a pupil holding a handout has no way to tell it is the Claude copy, because
 * there is no per-provider wording in it to notice. Provider-specific knobs
 * therefore live in {@link ProviderFrontmatter}, which is harness configuration
 * (frontmatter / TOML keys), never body text.
 */

/** The three layouts. `agents` is agy; Codex shares its instruction file. */
export type LayoutName = "claude" | "agents" | "codex";

export const LAYOUT_NAMES: readonly LayoutName[] = ["claude", "agents", "codex"];

export function isLayoutName(value: string): value is LayoutName {
  return (LAYOUT_NAMES as readonly string[]).includes(value);
}

/**
 * Per-provider frontmatter escape hatch. Merged into the skill/subagent header
 * of that layout only — e.g. `{ claude: { "allowed-tools": "Read, Grep" } }`.
 *
 * Body text is deliberately not overridable here. These keys are read by the
 * harness, not by the model, so they cannot leak the provider into the prose.
 */
export type ProviderFrontmatter = Partial<Record<LayoutName, Record<string, unknown>>>;

/**
 * A `## ` chunk of the instruction file. `heading` is the identity — renaming a
 * heading reads as delete + add, and `collect()` sees a heading it does not
 * recognise as a new section. A synthetic stable id would fix that, but nothing
 * exercises one yet, so it would be untested weight.
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
   * The subagent's own prompt. Handed out as the Markdown body for Claude/agy
   * and as `developer_instructions` for Codex.
   */
  instructions: string;
  providerFrontmatter?: ProviderFrontmatter;
}

/**
 * An always-on rule. Codex has no rules container at all, so rules are folded
 * into the instruction file for every layout (see `hand-out.ts`).
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

/** A set of handouts: path relative to the agent directory → file content. */
export type HandoutFiles = Record<string, string>;
