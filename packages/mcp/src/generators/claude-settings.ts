import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpServersConfig } from "../types.js";

/** Shape of `.mcp.json` we write or merge into. */
export interface ClaudeMcpJson {
  mcpServers?: McpServersConfig;
  [key: string]: unknown;
}

/** Relevant subset of `.claude/settings.local.json`. */
export interface ClaudeLocalSettings {
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

export interface ClaudeSettings {
  mcpJson: ClaudeMcpJson;
  localSettings: ClaudeLocalSettings;
}

/**
 * Build the Claude Code settings payloads for a set of MCP servers.
 *
 * - `.mcp.json` gets an entry per server (merged with any existing entries).
 * - `.claude/settings.local.json` sets `enableAllProjectMcpServers: true`
 *   and adds each server to `enabledMcpjsonServers` so Claude Code does not
 *   prompt for approval on every launch.
 */
export function generateClaudeSettings(
  mcpServers: McpServersConfig,
  existing?: { mcpJson?: ClaudeMcpJson; localSettings?: ClaudeLocalSettings },
): ClaudeSettings {
  const baseMcp = existing?.mcpJson ? { ...existing.mcpJson } : {};
  const mergedServers: McpServersConfig = {
    ...(baseMcp.mcpServers ?? {}),
    ...mcpServers,
  };
  const mcpJson: ClaudeMcpJson = { ...baseMcp, mcpServers: mergedServers };

  const baseLocal: ClaudeLocalSettings = existing?.localSettings
    ? { ...existing.localSettings }
    : {};
  const previouslyEnabled = Array.isArray(baseLocal.enabledMcpjsonServers)
    ? baseLocal.enabledMcpjsonServers
    : [];
  const enabledSet = new Set<string>([
    ...previouslyEnabled,
    ...Object.keys(mcpServers),
  ]);

  const localSettings: ClaudeLocalSettings = {
    ...baseLocal,
    enableAllProjectMcpServers: true,
    enabledMcpjsonServers: Array.from(enabledSet),
  };

  return { mcpJson, localSettings };
}

/**
 * Write both `.mcp.json` (at `cwd`) and `.claude/settings.local.json` with
 * the given MCP servers merged into any existing config. Returns the paths
 * that were written.
 */
export async function writeClaudeSettings(
  cwd: string,
  mcpServers: McpServersConfig,
): Promise<{ mcpJsonPath: string; localSettingsPath: string }> {
  const mcpJsonPath = join(cwd, ".mcp.json");
  const localSettingsPath = join(cwd, ".claude", "settings.local.json");

  const existingMcp = await readJsonIfExists<ClaudeMcpJson>(mcpJsonPath);
  const existingLocal = await readJsonIfExists<ClaudeLocalSettings>(localSettingsPath);

  const existing: {
    mcpJson?: ClaudeMcpJson;
    localSettings?: ClaudeLocalSettings;
  } = {};
  if (existingMcp) existing.mcpJson = existingMcp;
  if (existingLocal) existing.localSettings = existingLocal;

  const { mcpJson, localSettings } = generateClaudeSettings(mcpServers, existing);

  await mkdir(dirname(mcpJsonPath), { recursive: true });
  await writeFile(mcpJsonPath, `${JSON.stringify(mcpJson, null, 2)}\n`, "utf8");
  await mkdir(dirname(localSettingsPath), { recursive: true });
  await writeFile(
    localSettingsPath,
    `${JSON.stringify(localSettings, null, 2)}\n`,
    "utf8",
  );

  return { mcpJsonPath, localSettingsPath };
}

async function readJsonIfExists<T extends object>(
  filePath: string,
): Promise<T | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
