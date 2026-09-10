/**
 * **Briefing** — one provider-neutral statement of an agent's instructions,
 * handed out to Claude Code, agy and Codex.
 *
 * It sits next to `cli-adapter.ts` on purpose: that contract hides *how you
 * talk to* a provider, this one hides *where a provider keeps its
 * instructions*. A consuming app holds a briefing and learns neither.
 *
 * The vocabulary is a teacher handing out copies of one set of notes
 * (`docs/agent-briefing.md`):
 *
 *   handOut(briefing, layout)      briefing → handouts (pure; path → content)
 *   handOutAll(briefing)           every layout at once, shared paths checked
 *   detectMarkUps(briefing, dir)   which handouts somebody has written on
 *   collect(briefing, layout, dir) read those write-ins back into the briefing
 *   emptyBriefing(name)            something to collect a legacy directory into
 */

export type {
  Briefing,
  BriefingRule,
  BriefingSection,
  BriefingSkill,
  BriefingSubagent,
  HandoutFiles,
  LayoutName,
  ProviderFrontmatter,
} from "./types.js";
export { LAYOUT_NAMES, isLayoutName } from "./types.js";
export { LAYOUTS, type Layout } from "./layouts.js";
export { handOut, handOutAll, handOutInstructions } from "./hand-out.js";
export {
  collect,
  detectMarkUps,
  emptyBriefing,
  type CollectResult,
  type MarkedUpFile,
} from "./collect.js";
export { parseBriefing, serializeBriefing } from "./serialize.js";
export {
  fingerprintOf,
  isMarkedUp,
  normalizeTrailingNewline,
  stripFingerprint,
  withFingerprint,
} from "./fingerprint.js";
export { parseFrontmatter, splitSections, withFrontmatter } from "./markdown.js";
export { fromToml, toToml } from "./toml.js";
