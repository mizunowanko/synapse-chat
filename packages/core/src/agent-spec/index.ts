/**
 * Agent Spec — one provider-neutral description of an agent's instructions,
 * projected onto Claude Code, agy and Codex.
 *
 * It sits next to `cli-adapter.ts` on purpose: that contract hides *how you
 * talk to* a provider, this one hides *where a provider keeps its
 * instructions*. A consumer holds a spec and never learns either.
 *
 *   render(spec, target)      spec  → files (pure; returns path → content)
 *   renderAll(spec)           spec  → the whole tree, shared paths checked
 *   importFrom(dir, target)   files → spec  (one-shot migration bootstrap)
 *   detectEdits(spec, dir)    which generated files a human has since touched
 *   absorb(spec, target, dir) those edits → spec, so they reach every provider
 */

export type {
  AgentSpec,
  AgentSpecRule,
  AgentSpecSection,
  AgentSpecSkill,
  AgentSpecSubagent,
  ProviderFrontmatter,
  RenderTarget,
  RenderedFiles,
} from "./types.js";
export { RENDER_TARGETS, isRenderTarget } from "./types.js";
export { PROVIDER_LAYOUTS, type ProviderLayout } from "./providers.js";
export { render, renderAll, renderInstructions } from "./render.js";
export { importFrom } from "./import.js";
export { absorb, detectEdits, type AbsorbResult, type EditedFile } from "./absorb.js";
export { parseSpec, serializeSpec } from "./spec.js";
export {
  digestOf,
  isHandEdited,
  parseFrontmatter,
  splitSections,
  stripMarker,
  withFrontmatter,
  withMarker,
} from "./markdown.js";
export { fromToml, toToml } from "./toml.js";
