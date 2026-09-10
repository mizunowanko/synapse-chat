/**
 * The continuous reverse direction: a human edits a *generated* file, and the
 * spec follows so the edit reaches every other provider on the next render.
 *
 * This is what makes the SSoT survive contact with people. Nobody opens
 * `agent.spec.yaml` to fix a sentence — they open the `CLAUDE.md` that is
 * already in front of them. Without `absorb`, that edit is destroyed by the
 * next render, and the SSoT is a thing you have to remember to respect.
 *
 * **Only files that changed are read back.** The digest marker written by
 * `render` says what the generator produced; a file whose content still hashes
 * to its marker is by definition free of human input, and re-parsing it could
 * only introduce drift. `absorb` therefore touches exactly the files
 * {@link detectMarkUps} reports, which is also why running it twice with no edits
 * in between is a literal no-op rather than an approximate one.
 *
 * `importFrom` is the other direction of the same idea, for a directory that
 * was never generated: it reads everything, unconditionally, once.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { isMarkedUp, parseFrontmatter, splitSections, stripFingerprint } from "./markdown.js";
import { LAYOUTS, type Layout } from "./layouts.js";
import { render } from "./hand-out.js";
import { fromToml } from "./toml.js";
import {
  LAYOUT_NAMES,
  type Briefing,
  type BriefingRule,
  type BriefingSection,
  type BriefingSkill,
  type BriefingSubagent,
  type ProviderFrontmatter,
  type LayoutName,
} from "./types.js";

/** Frontmatter keys the spec owns; anything else is provider-specific and preserved. */
const OWNED_KEYS = new Set(["name", "description"]);
/** TOML keys the spec owns in a Codex subagent file. */
const OWNED_TOML_KEYS = new Set(["name", "description", "developer_instructions"]);

/** One generated file that no longer matches the digest it was stamped with. */
export interface MarkedUpFile {
  /** Path relative to the agent directory, e.g. `CLAUDE.md`. */
  path: string;
  /**
   * Every target that renders this path. `AGENTS.md` and `.agents/skills/…` are
   * shared, so they legitimately carry two targets — absorbing such a file from
   * either one gives the same spec.
   */
  targets: LayoutName[];
}

export interface CollectResult {
  spec: Briefing;
  /** Relative paths whose contents were taken into the spec. */
  absorbed: string[];
}

/**
 * Generated files under `dir` that a human has since edited.
 *
 * Only paths that `render` would produce are considered: a stray file in
 * `.claude/` is not ours, and reporting it as "edited" would push the caller
 * toward absorbing something we never wrote. Files that do not exist yet are
 * not edits either — they are just un-rendered.
 *
 * A file with no marker at all *is* reported, because it is hand-authored and
 * overwriting it would destroy the only copy.
 */
export function detectMarkUps(
  spec: Briefing,
  dir: string,
  targets: readonly LayoutName[] = LAYOUT_NAMES,
): MarkedUpFile[] {
  const byPath = new Map<string, LayoutName[]>();
  for (const target of targets) {
    for (const relative of Object.keys(handOut(spec, target))) {
      const absolute = join(dir, relative);
      if (!existsSync(absolute) || !isMarkedUp(readFileSync(absolute, "utf-8"))) continue;
      const seen = byPath.get(relative);
      if (seen) seen.push(target);
      else byPath.set(relative, [target]);
    }
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hits]) => ({ path, targets: hits }));
}

/**
 * Reads `target`'s edited files under `dir` back into `spec`.
 *
 * Returns a new spec; the input is not mutated. Anything the human did not
 * touch keeps the value it had in the spec, so absorbing from one provider does
 * not launder the whole file set through a parser.
 *
 * Skills and subagents that exist on disk but not in the spec are *added* —
 * that is how somebody adds a skill by dropping a directory next to the others.
 * The reverse is not true: a file that has disappeared leaves its spec entry
 * alone, because "not on disk" is also what a fresh checkout looks like, and
 * the spec is the only copy of the text.
 *
 * Legacy rule directories are deliberately not consulted. `render` folds rules
 * into the instruction file and emits no rules directory, so a `.claude/rules/`
 * file is never a generated artifact — `importFrom` picks those up once, during
 * migration.
 */
export function absorb(spec: Briefing, target: LayoutName, dir: string): CollectResult {
  const layout = LAYOUTS[target];
  const next: Briefing = structuredClone(spec);
  const absorbed: string[] = [];

  const instructions = readEdited(dir, layout.instructionFile);
  if (instructions !== null) {
    applyInstructions(next, instructions);
    absorbed.push(layout.instructionFile);
  }

  next.skills = absorbSkills(next, layout, target, dir, absorbed);
  next.subagents = absorbSubagents(next, layout, target, dir, absorbed);

  return { spec: next, absorbed };
}

/** Returns the marker-free content of a generated file iff a human edited it. */
function readEdited(dir: string, relative: string): string | null {
  const absolute = join(dir, relative);
  if (!existsSync(absolute)) return null;
  const raw = readFileSync(absolute, "utf-8");
  if (!isMarkedUp(raw)) return null;
  return stripFingerprint(raw).content;
}

/**
 * Re-splits the instruction file into title / role / sections / rules.
 *
 * Rules were folded in as trailing `## ` sections, so the only thing that can
 * tell them apart on the way back is the heading matching a rule the spec
 * already has. A heading the spec has never seen therefore becomes a section —
 * which is the right default: sections are the general case, and a new rule can
 * be promoted in the spec once.
 */
function applyInstructions(spec: Briefing, text: string): void {
  const lines = text.split("\n");
  const titleMatch = /^# +(.*?)\s*$/.exec(lines[0] ?? "");
  const withoutTitle = titleMatch ? lines.slice(1).join("\n") : text;
  const { preamble, sections } = splitSections(withoutTitle);

  if (titleMatch) {
    const title = titleMatch[1] ?? "";
    // Leave `displayName` unset if the title is still just the name, so
    // absorbing an unrelated edit does not spray defaults into the spec file.
    if (title !== (spec.displayName ?? spec.name)) spec.displayName = title;
  }
  if (preamble !== (spec.role?.trim() ?? "")) spec.role = preamble;

  const ruleNames = new Set(spec.rules.map((rule) => rule.name));
  const nextSections: BriefingSection[] = [];
  const nextRules: BriefingRule[] = [];
  for (const section of sections) {
    if (ruleNames.has(section.heading)) {
      nextRules.push({ name: section.heading, body: `${section.body}\n` });
    } else {
      nextSections.push({ heading: section.heading, body: `${section.body}\n` });
    }
  }
  spec.sections = nextSections;
  spec.rules = nextRules;
}

/**
 * Replaces `providerFrontmatter[target]` with the non-owned keys found on disk,
 * leaving the other targets' entries intact. An empty result removes the key
 * rather than storing `{}`, so a round trip through YAML compares equal.
 */
function mergeProviderFrontmatter(
  existing: ProviderFrontmatter | undefined,
  target: LayoutName,
  extras: Record<string, unknown>,
): { providerFrontmatter?: ProviderFrontmatter } {
  const merged: ProviderFrontmatter = { ...existing };
  if (Object.keys(extras).length > 0) merged[target] = extras;
  else delete merged[target];
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

function absorbSkills(
  spec: Briefing,
  layout: Layout,
  target: LayoutName,
  dir: string,
  absorbed: string[],
): BriefingSkill[] {
  const known = new Set(spec.skills.map((skill) => skill.name));
  const relativeOf = (name: string): string => `${layout.skillDir}/${name}/SKILL.md`;

  const updated = spec.skills.map((skill) => {
    const relative = relativeOf(skill.name);
    const content = readEdited(dir, relative);
    if (content === null) return skill;
    absorbed.push(relative);
    return toSkill(skill.name, content, target, skill.providerFrontmatter);
  });

  // Directories somebody added by hand. They carry no marker, so they read as
  // edited and are taken in whole.
  for (const name of listSubdirs(join(dir, layout.skillDir))) {
    if (known.has(name)) continue;
    const relative = relativeOf(name);
    const content = readEdited(dir, relative);
    if (content === null) continue;
    absorbed.push(relative);
    updated.push(toSkill(name, content, target, undefined));
  }

  return updated;
}

function toSkill(
  name: string,
  content: string,
  target: LayoutName,
  existing: ProviderFrontmatter | undefined,
): BriefingSkill {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    name: str(frontmatter?.name, name),
    description: str(frontmatter?.description, ""),
    body: `${body.trim()}\n`,
    ...mergeProviderFrontmatter(existing, target, nonOwnedKeys(frontmatter, OWNED_KEYS)),
  };
}

function absorbSubagents(
  spec: Briefing,
  layout: Layout,
  target: LayoutName,
  dir: string,
  absorbed: string[],
): BriefingSubagent[] {
  const isToml = layout.subagentFormat === "toml";
  const suffix = isToml ? ".toml" : ".md";
  const known = new Set(spec.subagents.map((subagent) => subagent.name));
  const relativeOf = (name: string): string => `${layout.subagentDir}/${name}${suffix}`;
  const parse = isToml ? toSubagentFromToml : toSubagentFromMarkdown;

  const updated = spec.subagents.map((subagent) => {
    const relative = relativeOf(subagent.name);
    const content = readEdited(dir, relative);
    if (content === null) return subagent;
    absorbed.push(relative);
    return parse(subagent.name, content, target, subagent.providerFrontmatter);
  });

  for (const file of listFiles(join(dir, layout.subagentDir), suffix)) {
    const name = basename(file, suffix);
    if (known.has(name)) continue;
    const relative = relativeOf(name);
    const content = readEdited(dir, relative);
    if (content === null) continue;
    absorbed.push(relative);
    updated.push(parse(name, content, target, undefined));
  }

  return updated;
}

function toSubagentFromMarkdown(
  name: string,
  content: string,
  target: LayoutName,
  existing: ProviderFrontmatter | undefined,
): BriefingSubagent {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    name: str(frontmatter?.name, name),
    description: str(frontmatter?.description, ""),
    instructions: `${body.trim()}\n`,
    ...mergeProviderFrontmatter(existing, target, nonOwnedKeys(frontmatter, OWNED_KEYS)),
  };
}

function toSubagentFromToml(
  name: string,
  content: string,
  target: LayoutName,
  existing: ProviderFrontmatter | undefined,
): BriefingSubagent {
  const table = fromToml(content);
  return {
    name: str(table.name, name),
    description: str(table.description, ""),
    instructions: `${String(table.developer_instructions ?? "").trim()}\n`,
    ...mergeProviderFrontmatter(existing, target, nonOwnedKeys(table, OWNED_TOML_KEYS)),
  };
}
