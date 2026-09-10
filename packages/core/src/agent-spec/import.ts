/**
 * Reverse projection, bounded to what the migration actually needs: read an
 * agent directory that was authored for one provider and lift it into a spec.
 *
 * This is the bootstrap for issue #50 — without it every agent's `CLAUDE.md`
 * would have to be retyped by hand. Once a directory *is* generated, the
 * continuous path is `absorb()`, which takes back only the files a human
 * actually touched; `importFrom` reads everything unconditionally and is meant
 * to be run once.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { parseFrontmatter, splitSections, stripMarker } from "./markdown.js";
import { PROVIDER_LAYOUTS } from "./providers.js";
import type {
  AgentSpec,
  AgentSpecRule,
  AgentSpecSkill,
  AgentSpecSubagent,
  RenderTarget,
} from "./types.js";

/** Frontmatter keys the spec owns; anything else is provider-specific and preserved. */
const OWNED_KEYS = new Set(["name", "description"]);

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(suffix))
    .sort()
    .map((entry) => join(dir, entry));
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .sort()
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isDirectory());
}

function splitProviderFrontmatter(
  frontmatter: Record<string, unknown> | null,
  target: RenderTarget,
): Pick<AgentSpecSkill, "providerFrontmatter"> {
  const rest = Object.fromEntries(
    Object.entries(frontmatter ?? {}).filter(([key]) => !OWNED_KEYS.has(key)),
  );
  return Object.keys(rest).length > 0 ? { providerFrontmatter: { [target]: rest } } : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/**
 * Lifts `dir` into a spec, reading it as `target`'s layout.
 *
 * Codex is import-only-in-theory: its subagents are TOML, and adding a TOML
 * *reader* to serve a migration path nobody walks (every existing agent here is
 * Claude-shaped) is surface we would not be able to exercise. It throws instead
 * of pretending.
 */
export function importFrom(dir: string, target: RenderTarget = "claude"): AgentSpec {
  const layout = PROVIDER_LAYOUTS[target];
  if (layout.subagentFormat === "toml") {
    throw new Error(
      `agent-spec: importing from "${target}" is not supported — import from "claude" or "agents".`,
    );
  }

  const name = basename(dir);
  const raw = readIfExists(join(dir, layout.instructionFile));
  if (raw === null) {
    throw new Error(`agent-spec: ${join(dir, layout.instructionFile)} not found.`);
  }

  const text = stripMarker(raw).content;
  const titleMatch = /^# +(.*?)\s*$/m.exec(text.split("\n")[0] ?? "");
  const withoutTitle = titleMatch ? text.split("\n").slice(1).join("\n") : text;
  const { preamble, sections } = splitSections(withoutTitle);

  const skills: AgentSpecSkill[] = [];
  for (const skillDir of listSubdirs(join(dir, layout.skillDir))) {
    const content = readIfExists(join(skillDir, "SKILL.md"));
    if (content === null) continue;
    const { frontmatter, body } = parseFrontmatter(stripMarker(content).content);
    skills.push({
      name: str(frontmatter?.name, basename(skillDir)),
      description: str(frontmatter?.description, ""),
      body: `${body.trim()}\n`,
      ...splitProviderFrontmatter(frontmatter, target),
    });
  }

  const subagents: AgentSpecSubagent[] = [];
  for (const file of listFiles(join(dir, layout.subagentDir), ".md")) {
    const { frontmatter, body } = parseFrontmatter(stripMarker(readFileSync(file, "utf-8")).content);
    subagents.push({
      name: str(frontmatter?.name, basename(file, ".md")),
      description: str(frontmatter?.description, ""),
      instructions: `${body.trim()}\n`,
      ...splitProviderFrontmatter(frontmatter, target),
    });
  }

  // Legacy rule files, if this agent had any. Nothing is rendered back into
  // these directories — rules are folded into the instruction body — but they
  // stay on disk, so import has to keep reading them.
  const rules: AgentSpecRule[] = [];
  if (layout.legacyRulesDir) {
    for (const file of listFiles(join(dir, layout.legacyRulesDir), ".md")) {
      const { frontmatter, body } = parseFrontmatter(
        stripMarker(readFileSync(file, "utf-8")).content,
      );
      rules.push({ name: str(frontmatter?.name, basename(file, ".md")), body: `${body.trim()}\n` });
    }
  }

  // A directory we rendered earlier carries each rule *twice*: once as the
  // folded `## <name>` section in the instruction file, and once as the legacy
  // rule file, which is still on disk because generation never deletes
  // (CLAUDE.md, Data Preservation). Dropping the section whose heading a rule
  // already owns is what makes render → import → render a fixed point instead
  // of a file that grows a duplicate rule on every pass.
  const ruleNames = new Set(rules.map((rule) => rule.name));

  return {
    name,
    displayName: titleMatch?.[1] ?? name,
    role: preamble,
    sections: sections
      .filter((section) => !ruleNames.has(section.heading))
      .map((section) => ({ heading: section.heading, body: `${section.body}\n` })),
    skills,
    subagents,
    rules,
  };
}
