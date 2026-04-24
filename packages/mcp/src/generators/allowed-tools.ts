import type { CliTarget, HttpToolDefinition } from "../types.js";

/** Map of MCP server name → tools exposed by that server. */
export type ToolsByServer = Record<string, readonly HttpToolDefinition[]>;

export interface DeriveAllowedToolsOptions {
  /** CLI that will read the allow-list. Determines the name format. */
  cli: CliTarget;
  /** Server name → list of tool definitions advertised by that server. */
  servers: ToolsByServer;
}

/**
 * Format a single MCP tool name for the given CLI.
 *
 * - Claude Code expects `mcp__<server>__<tool>`.
 * - Gemini CLI expects `<server>__<tool>` (no `mcp__` prefix).
 */
export function formatMcpToolName(
  cli: CliTarget,
  serverName: string,
  toolName: string,
): string {
  if (cli === "claude") return `mcp__${serverName}__${toolName}`;
  return `${serverName}__${toolName}`;
}

/**
 * Derive the list of CLI allowed-tool names from a mapping of MCP servers to
 * their tool definitions. Existing allow-lists can `concat()` the result to
 * add MCP tools without losing baseline permissions.
 */
export function deriveAllowedTools(options: DeriveAllowedToolsOptions): string[] {
  const { cli, servers } = options;
  const names: string[] = [];
  for (const [serverName, tools] of Object.entries(servers)) {
    for (const tool of tools) {
      names.push(formatMcpToolName(cli, serverName, tool.name));
    }
  }
  return names;
}
