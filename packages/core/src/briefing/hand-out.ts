/**
 * Handing the briefing out: Briefing → handouts. Pure — it returns a
 * path → content map and touches no filesystem.
 *
 * **Nothing in this package writes.** `handOut` gives back what each file
 * should contain and the caller decides what to do with it, which is what makes
 * "never delete" structural rather than a promise: an API whose only output is
 * `path → content` has no way to express a deletion. In the consuming app those
 * paths hold the only on-disk copy of a user's agent definitions.
 */

import { normalizeTrailingNewline, withFingerprint } from "./fingerprint.js";
import { LAYOUTS } from "./layouts.js";
import { withFrontmatter } from "./markdown.js";
import { toToml } from "./toml.js";
import { LAYOUT_NAMES, type Briefing, type HandoutFiles, type LayoutName } from "./types.js";

/**
 * The instruction file body. **Identical for every layout** — that identity is
 * the load-bearing property of the whole design, and `hand-out.test.ts` asserts
 * `CLAUDE.md === AGENTS.md` byte for byte.
 *
 * Rules are folded in here as trailing `## ` sections. Codex has no rules
 * container, so *some* layout has to fold; folding for only some of them would
 * split the shared `AGENTS.md`, and folding everywhere while *also* writing
 * `.claude/rules/` + `.agents/rules/` would hand Claude and agy each rule
 * twice. One place, every provider.
 */
export function handOutInstructions(briefing: Briefing): string {
  const parts: string[] = [`# ${briefing.displayName ?? briefing.name}`];
  const role = briefing.role?.trim();
  if (role) parts.push(role);
  for (const section of [...briefing.sections, ...briefing.rules.map(toSection)]) {
    parts.push(`## ${section.heading}\n\n${section.body.trim()}`);
  }
  return normalizeTrailingNewline(parts.join("\n\n"));
}

function toSection(rule: { name: string; body: string }): { heading: string; body: string } {
  return { heading: rule.name, body: rule.body };
}

function extras(
  providerFrontmatter: Partial<Record<LayoutName, Record<string, unknown>>> | undefined,
  layoutName: LayoutName,
): Record<string, unknown> {
  return providerFrontmatter?.[layoutName] ?? {};
}

/** Copies `briefing` into one layout. Keys are paths relative to the agent directory. */
export function handOut(briefing: Briefing, layoutName: LayoutName): HandoutFiles {
  const layout = LAYOUTS[layoutName];
  const files: HandoutFiles = {
    [layout.instructionFile]: withFingerprint(handOutInstructions(briefing)),
  };

  for (const skill of briefing.skills) {
    files[`${layout.skillDir}/${skill.name}/SKILL.md`] = withFingerprint(
      withFrontmatter(
        {
          name: skill.name,
          description: skill.description,
          ...extras(skill.providerFrontmatter, layoutName),
        },
        skill.body,
      ),
    );
  }

  for (const subagent of briefing.subagents) {
    if (layout.subagentFormat === "toml") {
      files[`${layout.subagentDir}/${subagent.name}.toml`] = withFingerprint(
        toToml({
          name: subagent.name,
          description: subagent.description,
          developer_instructions: normalizeTrailingNewline(subagent.instructions.trim()),
          ...extras(subagent.providerFrontmatter, layoutName),
        }),
        "toml",
      );
    } else {
      files[`${layout.subagentDir}/${subagent.name}.md`] = withFingerprint(
        withFrontmatter(
          {
            name: subagent.name,
            description: subagent.description,
            ...extras(subagent.providerFrontmatter, layoutName),
          },
          subagent.instructions,
        ),
      );
    }
  }

  return files;
}

/**
 * Hands out to every layout at once. `agents` and `codex` overlap on
 * `AGENTS.md` and `.agents/skills/`; the overlap must be byte-identical, and a
 * mismatch throws rather than being resolved by write order.
 *
 * A divergence there is exactly the failure the measurements turned up: given
 * two different sets of instructions for the same reader, agy said out loud
 * that `AGENTS.md` and `GEMINI.md` told it different things — naming the
 * adapter, which is the one thing the pupil must never be able to see.
 */
export function handOutAll(
  briefing: Briefing,
  layouts: readonly LayoutName[] = LAYOUT_NAMES,
): HandoutFiles {
  const merged: HandoutFiles = {};
  for (const layoutName of layouts) {
    for (const [path, content] of Object.entries(handOut(briefing, layoutName))) {
      const existing = merged[path];
      if (existing !== undefined && existing !== content) {
        throw new Error(
          `briefing: layouts disagree on ${path}. Shared handouts must be byte-identical.`,
        );
      }
      merged[path] = content;
    }
  }
  return merged;
}
