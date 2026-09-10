/**
 * `agent.spec.yaml` ↔ {@link AgentSpec}. Parsing validates, because a spec with
 * a missing `name` or a section without a heading renders a file that silently
 * says nothing — the failure would surface as an agent that quietly lost half
 * its instructions, which is the worst possible place to find it.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  AgentSpec,
  AgentSpecRule,
  AgentSpecSection,
  AgentSpecSkill,
  AgentSpecSubagent,
  ProviderFrontmatter,
} from "./types.js";
import { isRenderTarget } from "./types.js";

class SpecError extends Error {
  constructor(message: string) {
    super(`agent-spec: ${message}`);
    this.name = "SpecError";
  }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpecError(`${where} must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SpecError(`${where} is required and must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SpecError(`${where} must be a string.`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SpecError(`${where} must be a list.`);
  return value;
}

function providerFrontmatter(value: unknown, where: string): ProviderFrontmatter | undefined {
  if (value === undefined || value === null) return undefined;
  const table = record(value, where);
  const out: ProviderFrontmatter = {};
  for (const [target, keys] of Object.entries(table)) {
    if (!isRenderTarget(target)) {
      throw new SpecError(`${where}.${target} is not a known target (claude / agents / codex).`);
    }
    out[target] = record(keys, `${where}.${target}`);
  }
  return out;
}

function parseSections(value: unknown): AgentSpecSection[] {
  return list(value, "sections").map((entry, i) => {
    const table = record(entry, `sections[${i}]`);
    return {
      heading: requiredString(table.heading, `sections[${i}].heading`),
      body: optionalString(table.body, `sections[${i}].body`) ?? "",
    };
  });
}

function parseSkills(value: unknown): AgentSpecSkill[] {
  return list(value, "skills").map((entry, i) => {
    const table = record(entry, `skills[${i}]`);
    return {
      name: requiredString(table.name, `skills[${i}].name`),
      description: optionalString(table.description, `skills[${i}].description`) ?? "",
      body: optionalString(table.body, `skills[${i}].body`) ?? "",
      ...maybeFrontmatter(table.providerFrontmatter, `skills[${i}].providerFrontmatter`),
    };
  });
}

function parseSubagents(value: unknown): AgentSpecSubagent[] {
  return list(value, "subagents").map((entry, i) => {
    const table = record(entry, `subagents[${i}]`);
    return {
      name: requiredString(table.name, `subagents[${i}].name`),
      description: optionalString(table.description, `subagents[${i}].description`) ?? "",
      instructions: optionalString(table.instructions, `subagents[${i}].instructions`) ?? "",
      ...maybeFrontmatter(table.providerFrontmatter, `subagents[${i}].providerFrontmatter`),
    };
  });
}

function parseRules(value: unknown): AgentSpecRule[] {
  return list(value, "rules").map((entry, i) => {
    const table = record(entry, `rules[${i}]`);
    return {
      name: requiredString(table.name, `rules[${i}].name`),
      body: optionalString(table.body, `rules[${i}].body`) ?? "",
    };
  });
}

/**
 * `exactOptionalPropertyTypes` draws a line between "absent" and "present and
 * undefined", and the spec means the first one: an omitted `displayName` falls
 * back to `name` at render time, and writing the key with `undefined` in it
 * would survive into the YAML as a dangling `displayName:`.
 */
function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function maybeFrontmatter(value: unknown, where: string): { providerFrontmatter?: ProviderFrontmatter } {
  const parsed = providerFrontmatter(value, where);
  return parsed ? { providerFrontmatter: parsed } : {};
}

export function parseSpec(yaml: string): AgentSpec {
  const table = record(parseYaml(yaml), "spec");
  return {
    name: requiredString(table.name, "name"),
    ...optional("displayName", optionalString(table.displayName, "displayName")),
    ...optional("role", optionalString(table.role, "role")),
    sections: parseSections(table.sections),
    skills: parseSkills(table.skills),
    subagents: parseSubagents(table.subagents),
    rules: parseRules(table.rules),
  };
}

/**
 * Serializes back to YAML. `lineWidth: 0` disables folding so long Japanese
 * prose lines survive a round trip instead of being rewrapped into something a
 * `git diff` cannot follow.
 */
export function serializeSpec(spec: AgentSpec): string {
  return stringifyYaml(
    {
      name: spec.name,
      displayName: spec.displayName ?? spec.name,
      role: spec.role ?? "",
      sections: spec.sections,
      skills: spec.skills,
      subagents: spec.subagents,
      rules: spec.rules,
    },
    { lineWidth: 0 },
  );
}
