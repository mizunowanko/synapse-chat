/**
 * How each CLI is told to start the skills server (docs/design/skills-mcp.md).
 * Everything here is pure: it returns config text / argv / `path → content`,
 * and the caller decides where (and whether) to write it. No user-wide config
 * (`~/.claude`, `~/.codex`, `~/.gemini`) is ever involved.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerEntryConfig } from "../types.js";
import { SKILLS_SERVER_NAME } from "./server.js";

/** `$XDG_DATA_HOME/synapse-skills/skills.db`, else `~/.local/share/synapse-skills/skills.db`. */
export function defaultSkillsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(base, "synapse-skills", "skills.db");
}

export interface SkillsLaunchOptions {
  /** Absolute path of the store. Always written into the registration — the server's cwd differs per CLI. */
  readonly db: string;
  /** The agent this session is. Omit for a session that sees only the everyone tier. */
  readonly agent?: string;
  /** The desk of that agent, for desk-tier skills. Requires `agent`. */
  readonly desk?: string;
  /** Hide `put_skill`. */
  readonly readOnly?: boolean;
  /** Override the materialisation root (`~/.cache/synapse-skills`). */
  readonly cacheDir?: string;
  /** JSONL log of tool calls. */
  readonly log?: string;
  /** The Node binary. Default: the one running this code. */
  readonly node?: string;
  /** The server script. Default: this package's `dist/skills/cli.js`. */
  readonly cli?: string;
}

function defaultCli(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/** `{ command, args }` that starts one skills server for one session. */
export function skillsServerEntry(o: SkillsLaunchOptions): McpServerEntryConfig {
  if (!path.isAbsolute(o.db)) throw new Error(`skills db path must be absolute: ${o.db}`);
  if (o.desk !== undefined && o.agent === undefined) throw new Error("desk requires agent");
  const args = [o.cli ?? defaultCli(), "serve", "--db", o.db];
  if (o.agent !== undefined) args.push("--agent", o.agent);
  if (o.desk !== undefined) args.push("--desk", o.desk);
  if (o.readOnly) args.push("--read-only");
  if (o.cacheDir !== undefined) args.push("--cache-dir", o.cacheDir);
  if (o.log !== undefined) args.push("--log", o.log);
  return { command: o.node ?? process.execPath, args };
}

/** Claude Code: the JSON for `claude --mcp-config <file|json>` (or a project `.mcp.json`). */
export function claudeSkillsMcpConfig(o: SkillsLaunchOptions): { mcpServers: Record<string, McpServerEntryConfig> } {
  return { mcpServers: { [SKILLS_SERVER_NAME]: skillsServerEntry(o) } };
}

/** TOML basic strings accept every escape JSON.stringify emits. */
const tomlString = (s: string): string => JSON.stringify(s);

/** Codex: `-c` overrides for `codex` / `codex exec` (same keys as `[mcp_servers.skills]` in config.toml). */
export function codexSkillsConfigArgs(o: SkillsLaunchOptions): string[] {
  const e = skillsServerEntry(o);
  return [
    "-c",
    `mcp_servers.${SKILLS_SERVER_NAME}.command=${tomlString(e.command)}`,
    "-c",
    `mcp_servers.${SKILLS_SERVER_NAME}.args=[${(e.args ?? []).map(tomlString).join(", ")}]`,
  ];
}

/** Codex: the `[mcp_servers.skills]` table, for a `config.toml` you own (never `~/.codex`). */
export function codexSkillsConfigToml(o: SkillsLaunchOptions): string {
  const e = skillsServerEntry(o);
  return [
    `[mcp_servers.${SKILLS_SERVER_NAME}]`,
    `command = ${tomlString(e.command)}`,
    `args = [${(e.args ?? []).map(tomlString).join(", ")}]`,
    "",
  ].join("\n");
}

/**
 * agy: a workspace plugin, `.agents/plugins/<plugin>/{plugin.json,mcp_config.json}`.
 * agy has no project-level `mcp_config.json`; a workspace plugin is the only
 * registration that does not touch `~/.gemini`. The server's cwd becomes the
 * plugin directory, which is why every path is absolute.
 */
export function agySkillsPluginFiles(o: SkillsLaunchOptions, plugin = "synapse-skills"): Record<string, string> {
  const dir = `.agents/plugins/${plugin}`;
  return {
    [`${dir}/plugin.json`]: JSON.stringify({ name: plugin }, null, 2) + "\n",
    [`${dir}/mcp_config.json`]: JSON.stringify(claudeSkillsMcpConfig(o), null, 2) + "\n",
  };
}

/**
 * The paragraph to put in `AGENTS.md` (and `CLAUDE.md`; it does no harm there).
 * Codex neither passes MCP server instructions to the model nor shows MCP tools
 * up front, so without this it never learns the skills exist (#72: 0/9 → 9/9).
 * No skill names: the list lives in the server.
 */
export const SKILLS_AGENTS_MD_GUIDANCE = [
  "## スキル",
  "",
  `作業手順書（スキル）は MCP サーバー \`${SKILLS_SERVER_NAME}\` が配っている。頼まれた仕事を始める前に、\`${SKILLS_SERVER_NAME}\` の \`list_skills\` で一覧を見て、当てはまるものがあれば \`get_skill\` で取得し、その手順に従うこと。`,
  "",
].join("\n");
