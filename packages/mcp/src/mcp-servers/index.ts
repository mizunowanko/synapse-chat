/**
 * `@synapse-chat/mcp/mcp-servers` — the MCP servers an agent's sessions get,
 * kept provider-neutral in the skills SQLite file, in the skills' tiers
 * (everyone / agent / desk), and the launch inputs that hand them to Claude
 * Code / Codex / agy (docs/design/mcp-servers.md).
 *
 * A subpath, not the root entry: it needs `node:sqlite` (Node 22.13+).
 */
export {
  RESERVED_MCP_SERVER_NAMES,
  isMcpServerName,
  assertMcpServerName,
  envReferences,
  expandEnvReferences,
  expandMcpServerConfig,
  parseMcpServerConfig,
  parseMcpServerSpec,
  plaintextSecretKeys,
  type McpServerConfig,
  type StdioMcpServerConfig,
  type HttpMcpServerConfig,
  type McpServerSpec,
} from "./config.js";
export {
  McpServerStore,
  type McpServerScope,
  type McpServerViewer,
  type McpServerRecord,
  type PutMcpServerInput,
  type PutMcpServerResult,
  type EffectiveMcpServers,
} from "./store.js";
export {
  mcpServersLaunch,
  claudeMcpConfigArgs,
  withdrawMcpServersFiles,
  agyMcpServersPluginFiles,
  tomlBasicString,
  AGY_MCP_SERVERS_PLUGIN,
  CLAUDE_CWD_SHIM,
  type McpServerCli,
  type McpServersLaunch,
  type McpServersLaunchInput,
  type McpServersLaunchOptions,
  type ClaudeMcpServerEntry,
  type AgyMcpServerEntry,
} from "./launch.js";
