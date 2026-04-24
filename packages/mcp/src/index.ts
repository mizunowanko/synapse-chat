export type {
  HttpMethod,
  JsonSchema,
  ToolArgs,
  HttpToolDefinition,
  ToolResult,
  McpServerEntryConfig,
  McpServersConfig,
  CliTarget,
} from "./types.js";

export { defineHttpTool } from "./define-http-tool.js";

export {
  augmentSchemaForConfirmation,
  checkConfirmation,
  stripConfirmation,
  type ConfirmationAugmentedSchema,
} from "./confirmation.js";

export {
  callHttpTool,
  substitutePathParams,
  encodeQueryString,
  joinUrl,
  type CallHttpToolOptions,
  type FetchLike,
} from "./http-client.js";

export {
  createMcpServer,
  type CreateMcpServerOptions,
  type McpServerHandle,
} from "./create-mcp-server.js";

export {
  prepareMcpWorkspace,
  type PrepareMcpWorkspaceOptions,
  type PreparedMcpWorkspace,
} from "./prepare-workspace.js";

// Re-export generators from the top-level entry for convenience. The
// `./generators` subpath export is also available for tree-shaking fans.
export {
  generateGeminiSettings,
  writeGeminiSettings,
  generateClaudeSettings,
  writeClaudeSettings,
  deriveAllowedTools,
  formatMcpToolName,
  type GeminiSettings,
  type ClaudeSettings,
  type ClaudeMcpJson,
  type ClaudeLocalSettings,
  type DeriveAllowedToolsOptions,
  type ToolsByServer,
} from "./generators/index.js";
