/**
 * Where the skills server reads and writes skills. `SkillStore` (SQLite) is one;
 * an app can hand `createSkillsToolHandler` / `createSkillsMcpServer` its own.
 *
 * Exactly what the server uses, nothing more: the skills a viewer sees, one
 * skill by name, a skill's attached files, and writing a new version.
 */
import type { SkillViewer } from "./scope.js";
import type { PutSkillInput, PutSkillResult, SkillFile, SkillRecord } from "./store.js";

export interface SkillSource {
  /**
   * Every skill the viewer sees, one per name (the lowest tier wins), sorted by name.
   * Also feeds the server's `initialize` instructions.
   */
  list(viewer: SkillViewer): readonly SkillRecord[];
  /** The skill `name` as the viewer sees it, or `undefined`. */
  resolve(viewer: SkillViewer, name: string): SkillRecord | undefined;
  /**
   * The attached files of a record returned by `list` / `resolve` / `put`.
   * `get_skill` writes them to `<cacheRoot>/<name>@<version>/`, so one
   * `(name, version)` must always mean the same files.
   */
  files(record: SkillRecord): readonly SkillFile[];
  /**
   * Write a new version into `scope` (the session's own agent or desk tier;
   * `legacyDesk` only says where omitted fields may be carried over from).
   * A `description` / `files` left out of `input` carry over from the skill
   * the writer sees under that name. `changed: false` when nothing differs
   * from the latest version there (no new version is made).
   */
  put(scope: SkillViewer, input: PutSkillInput): PutSkillResult;
}
