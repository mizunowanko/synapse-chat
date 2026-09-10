/**
 * Projection: Agent Spec → provider files. Pure — it returns a path→content
 * map and touches no filesystem.
 *
 * **Nothing in this package writes.** `render` hands back what the files should
 * contain and the consumer decides what to do with it, which is what makes the
 * "never delete" rule structural rather than a promise: an API that only ever
 * returns `path → content` has no way to express a deletion.
 */

import { normalizeTrailingNewline, withFrontmatter, withMarker } from "./markdown.js";
import { PROVIDER_LAYOUTS } from "./providers.js";
import { toToml } from "./toml.js";
import { RENDER_TARGETS, type AgentSpec, type RenderTarget, type RenderedFiles } from "./types.js";

/**
 * The instruction file body. **Identical for every target** — that identity is
 * the load-bearing property of this whole design, and `render.test.ts` asserts
 * `CLAUDE.md === AGENTS.md` byte for byte.
 *
 * Rules are folded in here as trailing `## ` sections (issue #50
 * 「決めること」1). Codex has no rules container, so *some* target has to fold;
 * folding for only some targets would split the shared `AGENTS.md`, and folding
 * for all targets while *also* emitting `.claude/rules/` + `.agents/rules/`
 * would feed Claude and agy each rule twice. One place, every provider.
 */
export function renderInstructions(spec: AgentSpec): string {
  const parts: string[] = [`# ${spec.displayName ?? spec.name}`];
  const role = spec.role?.trim();
  if (role) parts.push(role);
  for (const section of [...spec.sections, ...spec.rules.map(toSection)]) {
    parts.push(`## ${section.heading}\n\n${section.body.trim()}`);
  }
  return normalizeTrailingNewline(parts.join("\n\n"));
}

function toSection(rule: { name: string; body: string }): { heading: string; body: string } {
  return { heading: rule.name, body: rule.body };
}

function extras(
  providerFrontmatter: Partial<Record<RenderTarget, Record<string, unknown>>> | undefined,
  target: RenderTarget,
): Record<string, unknown> {
  return providerFrontmatter?.[target] ?? {};
}

/** Projects `spec` onto one provider. Keys are paths relative to the agent directory. */
export function render(spec: AgentSpec, target: RenderTarget): RenderedFiles {
  const layout = PROVIDER_LAYOUTS[target];
  const files: RenderedFiles = {
    [layout.instructionFile]: withMarker(renderInstructions(spec)),
  };

  for (const skill of spec.skills) {
    files[`${layout.skillDir}/${skill.name}/SKILL.md`] = withMarker(
      withFrontmatter(
        { name: skill.name, description: skill.description, ...extras(skill.providerFrontmatter, target) },
        skill.body,
      ),
    );
  }

  for (const subagent of spec.subagents) {
    if (layout.subagentFormat === "toml") {
      files[`${layout.subagentDir}/${subagent.name}.toml`] = withMarker(
        toToml({
          name: subagent.name,
          description: subagent.description,
          developer_instructions: normalizeTrailingNewline(subagent.instructions.trim()),
          ...extras(subagent.providerFrontmatter, target),
        }),
        "toml",
      );
    } else {
      files[`${layout.subagentDir}/${subagent.name}.md`] = withMarker(
        withFrontmatter(
          {
            name: subagent.name,
            description: subagent.description,
            ...extras(subagent.providerFrontmatter, target),
          },
          subagent.instructions,
        ),
      );
    }
  }

  return files;
}

/**
 * Projects onto every provider at once. `agents` and `codex` overlap on
 * `AGENTS.md` and `.agents/skills/`; the overlap must be byte-identical, and a
 * mismatch is thrown rather than silently resolved by write order — a
 * divergence there is exactly the failure the issue documents (agy noticing it
 * had been given two different sets of instructions and naming the adapter out
 * loud).
 */
export function renderAll(spec: AgentSpec, targets: readonly RenderTarget[] = RENDER_TARGETS): RenderedFiles {
  const merged: RenderedFiles = {};
  for (const target of targets) {
    for (const [path, content] of Object.entries(render(spec, target))) {
      const existing = merged[path];
      if (existing !== undefined && existing !== content) {
        throw new Error(
          `agent-spec: targets disagree on ${path}. Shared files must render identically.`,
        );
      }
      merged[path] = content;
    }
  }
  return merged;
}
