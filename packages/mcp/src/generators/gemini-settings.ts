import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpServersConfig } from "../types.js";

/** Shape of `.gemini/settings.json` we write or merge into. */
export interface GeminiSettings {
  mcpServers?: McpServersConfig;
  [key: string]: unknown;
}

/**
 * Build the Gemini-CLI `settings.json` payload for a set of MCP servers.
 *
 * If `existing` is passed, its `mcpServers` map is shallow-merged with the
 * provided definitions (new entries win) and every other top-level field is
 * preserved verbatim.
 */
export function generateGeminiSettings(
  mcpServers: McpServersConfig,
  existing?: GeminiSettings,
): GeminiSettings {
  const base = existing ? { ...existing } : {};
  const merged: McpServersConfig = {
    ...(base.mcpServers ?? {}),
    ...mcpServers,
  };
  return { ...base, mcpServers: merged };
}

/**
 * Write `<cwd>/.gemini/settings.json` with the given MCP servers merged in.
 * Creates the parent directory if missing. Existing fields in the settings
 * file are preserved.
 */
export async function writeGeminiSettings(
  cwd: string,
  mcpServers: McpServersConfig,
): Promise<string> {
  const dir = join(cwd, ".gemini");
  const filePath = join(dir, "settings.json");
  const existing = await readJsonIfExists(filePath);
  const payload = generateGeminiSettings(mcpServers, existing ?? undefined);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

async function readJsonIfExists(filePath: string): Promise<GeminiSettings | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as GeminiSettings;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
