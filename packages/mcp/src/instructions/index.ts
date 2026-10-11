/**
 * `@synapse-chat/mcp/instructions` — agents' standing instructions kept in the
 * skills SQLite file, in two tiers (everyone / agent), and the launch inputs
 * that put them in front of Claude Code / Codex / agy
 * (docs/design/instructions.md).
 *
 * A subpath, not the root entry: it needs `node:sqlite` (Node 22.13+).
 */
export {
  InstructionStore,
  GLOBAL_INSTRUCTIONS,
  agentInstructions,
  instructionTierOf,
  describeInstructionScope,
  normalizeInstructions,
  type InstructionScope,
  type InstructionTier,
  type InstructionRecord,
  type PutInstructionsResult,
} from "./store.js";
export {
  renderInstructions,
  effectiveInstructions,
  readInstructionFile,
  type RenderInstructionsOptions,
  type EffectiveInstructions,
} from "./render.js";
export {
  INSTRUCTION_CLIS,
  isInstructionCli,
  instructionsLaunch,
  withdrawInstructionsFiles,
  claudeInstructionExcludes,
  agyInstructionsPluginFiles,
  chunkInstructions,
  AGY_INSTRUCTIONS_PLUGIN,
  AGY_RULE_BYTES,
  AGY_RULE_SLOTS,
  type InstructionCli,
  type InstructionsLaunch,
  type InstructionsLaunchOptions,
} from "./launch.js";
