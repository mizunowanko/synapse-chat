/**
 * `@synapse-chat/mcp/skills` — skills kept in SQLite and handed to CLI
 * sessions by a stdio MCP server (docs/design/skills-mcp.md).
 *
 * A subpath, not the root entry: it needs `node:sqlite` (Node 22.13+), and the
 * root entry stays usable on Node 20.
 */
export {
  GLOBAL_SCOPE,
  agentScope,
  deskScope,
  describeScope,
  tierOf,
  visibleScopes,
  mcpWriteRefusal,
  assertSkillName,
  type SkillScope,
  type ScopeTier,
} from "./scope.js";
export {
  SkillStore,
  assertSkillFilePath,
  type SkillFile,
  type SkillRecord,
  type PutSkillInput,
  type PutSkillResult,
} from "./store.js";
export { materializeSkill, defaultCacheRoot, type MaterializedSkill } from "./materialize.js";
export {
  createSkillsMcpServer,
  createSkillsToolHandler,
  buildSkillsInstructions,
  SKILLS_SERVER_NAME,
  type SkillsServerOptions,
  type SkillsServerHandle,
} from "./server.js";
export { readSkillDir, findSkillDirs, writeSkillDir, renderSkillMd, type ReadSkillDirResult } from "./skill-dir.js";
export {
  defaultSkillsDbPath,
  skillsServerEntry,
  claudeSkillsMcpConfig,
  codexSkillsConfigArgs,
  codexSkillsConfigToml,
  agySkillsPluginFiles,
  SKILLS_AGENTS_MD_GUIDANCE,
  type SkillsLaunchOptions,
} from "./registration.js";
