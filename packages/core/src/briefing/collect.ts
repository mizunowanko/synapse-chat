/**
 * Collecting the handouts back in.
 *
 * Somebody wrote on their copy. `collect()` reads what they wrote into the
 * briefing, so the next `handOut()` carries it to everyone else. That round
 * trip is what makes the briefing survive contact with people: nobody opens
 * `<name>.briefing.yaml` to fix a sentence — they fix the `CLAUDE.md` that is
 * already in front of them.
 *
 * A handout is read back when **somebody wrote on it, or the briefing has no
 * entry for what it holds.** Both halves matter:
 *
 *  - The fingerprint says what we produced. A handout that still hashes to its
 *    own fingerprint holds no human input, so re-parsing it could only
 *    introduce drift. Collecting twice with nothing written in between is a
 *    literal no-op rather than an approximate one.
 *  - A fingerprint only means "we generated this from *a* briefing" — never
 *    "the briefing in your hand already covers it". A skill this briefing has
 *    no entry for is taken in whichever way it got there, because skipping it
 *    would drop the only copy on the floor.
 *
 * Together they make one call do the migration too: point `collect()` at a
 * hand-authored `agents/Amanatsu/` with {@link emptyBriefing} and every file
 * reads as new, which is the whole of what an import needs. That is why this is
 * one function and not two.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { isMarkedUp, stripFingerprint } from "./fingerprint.js";
import { handOut } from "./hand-out.js";
import { LAYOUTS, type Layout } from "./layouts.js";
import { parseFrontmatter, splitSections } from "./markdown.js";
import { fromToml } from "./toml.js";
import {
  LAYOUT_NAMES,
  type Briefing,
  type BriefingRule,
  type BriefingSection,
  type BriefingSkill,
  type BriefingSubagent,
  type LayoutName,
  type ProviderFrontmatter,
} from "./types.js";

/** Frontmatter keys the briefing owns; anything else belongs to the provider. */
const OWNED_KEYS = new Set(["name", "description"]);
/** TOML keys the briefing owns in a Codex subagent handout. */
const OWNED_TOML_KEYS = new Set(["name", "description", "developer_instructions"]);

/** A handout that no longer matches the fingerprint it was stamped with. */
export interface MarkedUpFile {
  /** Path relative to the agent directory, e.g. `CLAUDE.md`. */
  path: string;
  /**
   * Every layout that hands out this path. `AGENTS.md` and `.agents/skills/…`
   * are shared, so they legitimately carry two — collecting such a file from
   * either one gives the same briefing.
   */
  layouts: LayoutName[];
}

export interface CollectResult {
  briefing: Briefing;
  /** Relative paths whose contents were taken into the briefing. */
  collected: string[];
}

/** A briefing with nothing in it, to collect a never-handed-out directory into. */
export function emptyBriefing(name: string): Briefing {
  return { name, sections: [], skills: [], subagents: [], rules: [] };
}

/**
 * Handouts under `dir` that somebody has written on.
 *
 * Only paths that `handOut` would produce are considered: a stray file in
 * `.claude/` is not one of ours, and reporting it would push the caller toward
 * collecting something we never wrote. A file that does not exist is not a
 * mark-up either — it is simply not handed out yet.
 *
 * A file with no fingerprint at all *is* reported, because it is hand-authored
 * and handing out over it would destroy the only copy.
 */
export function detectMarkUps(
  briefing: Briefing,
  dir: string,
  layouts: readonly LayoutName[] = LAYOUT_NAMES,
): MarkedUpFile[] {
  const byPath = new Map<string, LayoutName[]>();
  for (const layoutName of layouts) {
    for (const relative of Object.keys(handOut(briefing, layoutName))) {
      const absolute = join(dir, relative);
      if (!existsSync(absolute) || !isMarkedUp(readFileSync(absolute, "utf-8"))) continue;
      const seen = byPath.get(relative);
      if (seen) seen.push(layoutName);
      else byPath.set(relative, [layoutName]);
    }
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hits]) => ({ path, layouts: hits }));
}

/**
 * Reads the marked-up handouts of one layout under `dir` back into `briefing`.
 *
 * Returns a new briefing; the input is not mutated. Anything nobody wrote on
 * keeps the value it already had, so collecting from one provider does not
 * launder the whole file set through a parser.
 *
 * Skills and subagents present on disk but absent from the briefing are
 * *added* — that is how somebody adds a skill, by dropping a directory next to
 * the others. The reverse does not hold: a file that has disappeared leaves its
 * briefing entry alone, because "not on disk" is also what a fresh checkout
 * looks like, and the briefing is the only copy of the text.
 */
export function collect(briefing: Briefing, layoutName: LayoutName, dir: string): CollectResult {
  const layout = LAYOUTS[layoutName];
  const next: Briefing = structuredClone(briefing);
  const collected: string[] = [];
  // Nothing in the briefing describes an instruction file yet, so whatever is
  // on disk is new rather than stale — even if we are the ones who wrote it.
  const instructionsAreNew =
    next.sections.length === 0 && next.rules.length === 0 && (next.role ?? "").trim() === "";

  // Legacy rule files first: they never appear in a handout, so they only ever
  // matter while bootstrapping a directory that predates this module. What they
  // contribute is the *names* — which `## ` headings in the instruction file are
  // rules rather than sections.
  const legacyRules = readLegacyRules(layout, dir, collected);

  const instructions = readCollectable(dir, layout.instructionFile, instructionsAreNew);
  if (instructions !== null) {
    applyInstructions(next, instructions, legacyRules);
    collected.push(layout.instructionFile);
  } else if (legacyRules.length > 0) {
    mergeRules(next, legacyRules);
  }

  next.skills = collectSkills(next, layout, layoutName, dir, collected);
  next.subagents = collectSubagents(next, layout, layoutName, dir, collected);

  return { briefing: next, collected };
}

/**
 * The fingerprint-free content of a handout, if there is any reason to read it.
 *
 * `isNew` is the escape hatch for things the briefing has no entry for, where a
 * valid fingerprint proves only that *some* briefing produced the file — not
 * that the one in our hand still knows about it.
 */
function readCollectable(dir: string, relative: string, isNew: boolean): string | null {
  const absolute = join(dir, relative);
  if (!existsSync(absolute)) return null;
  const raw = readFileSync(absolute, "utf-8");
  if (!isNew && !isMarkedUp(raw)) return null;
  return stripFingerprint(raw).content;
}

/** Returns the fingerprint-free content of a handout iff somebody wrote on it. */
function readMarkedUp(dir: string, relative: string): string | null {
  return readCollectable(dir, relative, false);
}

function readLegacyRules(layout: Layout, dir: string, collected: string[]): BriefingRule[] {
  if (!layout.legacyRulesDir) return [];
  const rules: BriefingRule[] = [];
  for (const file of listFiles(join(dir, layout.legacyRulesDir), ".md")) {
    const relative = `${layout.legacyRulesDir}/${file}`;
    const content = readMarkedUp(dir, relative);
    if (content === null) continue;
    const { frontmatter, body } = parseFrontmatter(content);
    rules.push({ name: str(frontmatter?.name, basename(file, ".md")), body: `${body.trim()}\n` });
    collected.push(relative);
  }
  return rules;
}

function mergeRules(briefing: Briefing, incoming: BriefingRule[]): void {
  const byName = new Map(briefing.rules.map((rule) => [rule.name, rule]));
  for (const rule of incoming) byName.set(rule.name, rule);
  briefing.rules = [...byName.values()];
}

/**
 * Re-splits the instruction file into title / role / sections / rules.
 *
 * Rules were folded in as trailing `## ` sections, so the only thing that can
 * tell them apart on the way back is the heading matching a rule we already
 * know about — either from the briefing or from a legacy rules directory. A
 * heading nobody has seen becomes a section, which is the right default:
 * sections are the general case, and a rule can be promoted once by hand.
 *
 * This is also what stops a handed-out directory from growing a duplicate rule
 * on every pass. Such a directory carries each rule twice — folded into the
 * instruction file, and still sitting in the legacy rules directory, because
 * handing out never deletes. Matching by name collapses the two back into one.
 */
function applyInstructions(briefing: Briefing, text: string, legacyRules: BriefingRule[]): void {
  const lines = text.split("\n");
  const titleMatch = /^# +(.*?)\s*$/.exec(lines[0] ?? "");
  const withoutTitle = titleMatch ? lines.slice(1).join("\n") : text;
  const { preamble, sections } = splitSections(withoutTitle);

  if (titleMatch) {
    const title = titleMatch[1] ?? "";
    // Leave `displayName` unset while the title is still just the name, so
    // collecting an unrelated edit does not spray defaults into the briefing.
    if (title !== (briefing.displayName ?? briefing.name)) briefing.displayName = title;
  }
  if (preamble !== (briefing.role?.trim() ?? "")) briefing.role = preamble;

  const legacyByName = new Map(legacyRules.map((rule) => [rule.name, rule]));
  const ruleNames = new Set([...briefing.rules.map((rule) => rule.name), ...legacyByName.keys()]);

  const nextSections: BriefingSection[] = [];
  const nextRules: BriefingRule[] = [];
  for (const section of sections) {
    if (ruleNames.has(section.heading)) {
      // The folded copy is the fresher one, so it wins over the legacy file.
      nextRules.push({ name: section.heading, body: `${section.body}\n` });
      legacyByName.delete(section.heading);
    } else {
      nextSections.push({ heading: section.heading, body: `${section.body}\n` });
    }
  }
  // Legacy rules with no folded section have never been handed out; keep them.
  briefing.sections = nextSections;
  briefing.rules = [...nextRules, ...legacyByName.values()];
}

/**
 * Replaces `providerFrontmatter[layoutName]` with the non-owned keys found on
 * disk, leaving the other layouts' entries intact. An empty result drops the
 * key rather than storing `{}`, so a round trip through YAML compares equal.
 */
function mergeProviderFrontmatter(
  existing: ProviderFrontmatter | undefined,
  layoutName: LayoutName,
  extras: Record<string, unknown>,
): { providerFrontmatter?: ProviderFrontmatter } {
  const merged: ProviderFrontmatter = { ...existing };
  if (Object.keys(extras).length > 0) merged[layoutName] = extras;
  else delete merged[layoutName];
  return Object.keys(merged).length > 0 ? { providerFrontmatter: merged } : {};
}

function nonOwnedKeys(
  table: Record<string, unknown> | null,
  owned: Set<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(table ?? {}).filter(([key]) => !owned.has(key)));
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .sort()
    .filter((entry) => statSync(join(dir, entry)).isDirectory());
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(suffix))
    .sort();
}

function collectSkills(
  briefing: Briefing,
  layout: Layout,
  layoutName: LayoutName,
  dir: string,
  collected: string[],
): BriefingSkill[] {
  const known = new Set(briefing.skills.map((skill) => skill.name));
  const relativeOf = (name: string): string => `${layout.skillDir}/${name}/SKILL.md`;

  const updated = briefing.skills.map((skill) => {
    const relative = relativeOf(skill.name);
    const content = readMarkedUp(dir, relative);
    if (content === null) return skill;
    collected.push(relative);
    return toSkill(skill.name, content, layoutName, skill.providerFrontmatter);
  });

  // Skills the briefing has no entry for — added by hand, or left over from a
  // briefing we no longer hold. Either way this is the only copy.
  for (const name of listSubdirs(join(dir, layout.skillDir))) {
    if (known.has(name)) continue;
    const relative = relativeOf(name);
    const content = readCollectable(dir, relative, true);
    if (content === null) continue;
    collected.push(relative);
    updated.push(toSkill(name, content, layoutName, undefined));
  }

  return updated;
}

function toSkill(
  name: string,
  content: string,
  layoutName: LayoutName,
  existing: ProviderFrontmatter | undefined,
): BriefingSkill {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    name: str(frontmatter?.name, name),
    description: str(frontmatter?.description, ""),
    body: `${body.trim()}\n`,
    ...mergeProviderFrontmatter(existing, layoutName, nonOwnedKeys(frontmatter, OWNED_KEYS)),
  };
}

function collectSubagents(
  briefing: Briefing,
  layout: Layout,
  layoutName: LayoutName,
  dir: string,
  collected: string[],
): BriefingSubagent[] {
  const isToml = layout.subagentFormat === "toml";
  const suffix = isToml ? ".toml" : ".md";
  const known = new Set(briefing.subagents.map((subagent) => subagent.name));
  const relativeOf = (name: string): string => `${layout.subagentDir}/${name}${suffix}`;
  const parse = isToml ? toSubagentFromToml : toSubagentFromMarkdown;

  const updated = briefing.subagents.map((subagent) => {
    const relative = relativeOf(subagent.name);
    const content = readMarkedUp(dir, relative);
    if (content === null) return subagent;
    collected.push(relative);
    return parse(subagent.name, content, layoutName, subagent.providerFrontmatter);
  });

  for (const file of listFiles(join(dir, layout.subagentDir), suffix)) {
    const name = basename(file, suffix);
    if (known.has(name)) continue;
    const relative = relativeOf(name);
    const content = readCollectable(dir, relative, true);
    if (content === null) continue;
    collected.push(relative);
    updated.push(parse(name, content, layoutName, undefined));
  }

  return updated;
}

function toSubagentFromMarkdown(
  name: string,
  content: string,
  layoutName: LayoutName,
  existing: ProviderFrontmatter | undefined,
): BriefingSubagent {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    name: str(frontmatter?.name, name),
    description: str(frontmatter?.description, ""),
    instructions: `${body.trim()}\n`,
    ...mergeProviderFrontmatter(existing, layoutName, nonOwnedKeys(frontmatter, OWNED_KEYS)),
  };
}

function toSubagentFromToml(
  name: string,
  content: string,
  layoutName: LayoutName,
  existing: ProviderFrontmatter | undefined,
): BriefingSubagent {
  const table = fromToml(content);
  return {
    name: str(table.name, name),
    description: str(table.description, ""),
    instructions: `${String(table.developer_instructions ?? "").trim()}\n`,
    ...mergeProviderFrontmatter(existing, layoutName, nonOwnedKeys(table, OWNED_TOML_KEYS)),
  };
}
