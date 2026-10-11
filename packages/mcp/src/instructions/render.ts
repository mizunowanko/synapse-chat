/**
 * What a session is told: the everyone tier, then the agent tier
 * (docs/design/instructions.md).
 */
import fs from "node:fs";
import { stripFingerprint } from "@synapse-chat/core/briefing";
import { SKILLS_AGENTS_MD_GUIDANCE } from "../skills/registration.js";
import {
  GLOBAL_INSTRUCTIONS,
  agentInstructions,
  normalizeInstructions,
  type InstructionStore,
} from "./store.js";

export interface RenderInstructionsOptions {
  /**
   * Put the skills paragraph (`SKILLS_AGENTS_MD_GUIDANCE`, heading `## スキル`)
   * first when neither tier already has that heading. Default `true`: Codex
   * does not use the skills server without it (docs/design/skills-mcp.md).
   */
  readonly skillsGuidance?: boolean;
}

const SKILLS_HEADING = SKILLS_AGENTS_MD_GUIDANCE.split("\n")[0]!;

function hasHeading(text: string, heading: string): boolean {
  return text.split("\n").some((line) => line.trimEnd() === heading);
}

/**
 * Join the tiers: everyone first, the agent appended after it, so where the
 * two disagree the agent's text is the later word. Empty when both are empty
 * (no skills paragraph on its own either).
 */
export function renderInstructions(
  parts: { readonly global?: string | undefined; readonly agent?: string | undefined },
  options: RenderInstructionsOptions = {},
): string {
  const tiers = [parts.global, parts.agent]
    .map((t) => normalizeInstructions(t ?? ""))
    .filter((t) => t !== "");
  if (tiers.length === 0) return "";
  const joined = tiers.join("\n");
  const guidance = (options.skillsGuidance ?? true) && !hasHeading(joined, SKILLS_HEADING);
  return normalizeInstructions(guidance ? `${SKILLS_AGENTS_MD_GUIDANCE}\n${joined}` : joined);
}

export interface EffectiveInstructions {
  /** The rendered text. `""` when neither tier has live instructions. */
  readonly text: string;
  /** The everyone tier's version, when it has live instructions. */
  readonly globalVersion?: number;
  /** The agent tier's version, when it has live instructions. */
  readonly agentVersion?: number;
}

/** The instructions `agent` sees (`undefined`: only the everyone tier). */
export function effectiveInstructions(
  store: InstructionStore,
  agent?: string,
  options: RenderInstructionsOptions = {},
): EffectiveInstructions {
  const global = store.get(GLOBAL_INSTRUCTIONS);
  const own = agent === undefined ? undefined : store.get(agentInstructions(agent));
  return {
    text: renderInstructions({ global: global?.body, agent: own?.body }, options),
    ...(global ? { globalVersion: global.version } : {}),
    ...(own ? { agentVersion: own.version } : {}),
  };
}

/**
 * An instruction file as it goes into the store: Briefing fingerprint lines
 * (`<!-- briefing:v1 fingerprint=… -->`) removed — they mark a generated
 * handout, not text anyone wrote — and line ends normalised.
 */
export function readInstructionFile(file: string): string {
  return normalizeInstructions(stripFingerprint(fs.readFileSync(file, "utf8")).content);
}
