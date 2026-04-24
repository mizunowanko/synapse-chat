import { writeClaudeSettings } from "./generators/claude-settings.js";
import { writeGeminiSettings } from "./generators/gemini-settings.js";
import type { CliTarget, McpServersConfig } from "./types.js";

export interface PrepareMcpWorkspaceOptions {
  /** CLI the worktree will be used with. */
  cli: CliTarget;
  /** MCP server spawn configs to register. */
  mcpServers: McpServersConfig;
}

/** Paths written by {@link prepareMcpWorkspace}. */
export interface PreparedMcpWorkspace {
  /** `.gemini/settings.json` (only present when `cli === "gemini"`). */
  geminiSettingsPath?: string;
  /** `.mcp.json` (only present when `cli === "claude"`). */
  mcpJsonPath?: string;
  /** `.claude/settings.local.json` (only present when `cli === "claude"`). */
  claudeLocalSettingsPath?: string;
}

/**
 * Place CLI-specific MCP config files in `cwd` so the CLI picks the
 * configured servers up on launch.
 *
 * For Claude Code: writes `.mcp.json` (server definitions) plus
 * `.claude/settings.local.json` (auto-approval so Claude does not prompt).
 *
 * For Gemini CLI: writes `.gemini/settings.json`.
 *
 * Existing config files are merged — callers do not lose unrelated settings.
 */
export async function prepareMcpWorkspace(
  cwd: string,
  options: PrepareMcpWorkspaceOptions,
): Promise<PreparedMcpWorkspace> {
  if (options.cli === "gemini") {
    const geminiSettingsPath = await writeGeminiSettings(cwd, options.mcpServers);
    return { geminiSettingsPath };
  }
  const { mcpJsonPath, localSettingsPath } = await writeClaudeSettings(
    cwd,
    options.mcpServers,
  );
  return {
    mcpJsonPath,
    claudeLocalSettingsPath: localSettingsPath,
  };
}
