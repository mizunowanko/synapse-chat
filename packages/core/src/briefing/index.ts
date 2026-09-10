/**
 * Agent Spec — one provider-neutral description of an agent's instructions,
 * projected onto Claude Code, agy and Codex.
 *
 * It sits next to `cli-adapter.ts` on purpose: that contract hides *how you
 * talk to* a provider, this one hides *where a provider keeps its
 * instructions*. A consumer holds a spec and never learns either.
 *
 *   handOut(spec, target)      spec  → files (pure; returns path → content)
 *   handOutAll(spec)           spec  → the whole tree, shared paths checked
 *   importFrom(dir, target)   files → spec  (one-shot migration bootstrap)
 *   detectMarkUps(spec, dir)    which generated files a human has since touched
 *   absorb(spec, target, dir) those edits → spec, so they reach every provider
 */

export type {
  Briefing,
  BriefingRule,
  BriefingSection,
  BriefingSkill,
  BriefingSubagent,
  ProviderFrontmatter,
  LayoutName,
  HandoutFiles,
} from "./types.js";
export { LAYOUT_NAMES, isLayoutName } from "./types.js";
export { LAYOUTS, type Layout } from "./layouts.js";
export { render, handOutAll, handOutInstructions } from "./hand-out.js";
export { importFrom } from "./collect.js";
export { absorb, detectMarkUps, type CollectResult, type MarkedUpFile } from "./collect.js";
export { parseBriefing, serializeBriefing } from "./serialize.js";
export {
  fingerprintOf,
  isMarkedUp,
  parseFrontmatter,
  splitSections,
  stripFingerprint,
  withFrontmatter,
  withFingerprint,
} from "./markdown.js";
export { fromToml, toToml } from "./toml.js";
