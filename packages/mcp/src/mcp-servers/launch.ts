/**
 * How each CLI is given the ledger's MCP servers at launch
 * (docs/design/mcp-servers.md).
 *
 * Pure: returns the `mcpServers` entries / argv / `path → content`, and the
 * caller decides where to put them, merged with its own servers (the skills
 * server, an app's HTTP servers). Nothing here writes a file or touches
 * user-wide config (`~/.claude`, `~/.codex`, `~/.gemini`).
 */
import type { InstructionCli } from "../instructions/launch.js";
import {
  RESERVED_MCP_SERVER_NAMES,
  expandMcpServerConfig,
  isMcpServerName,
  type McpServerConfig,
} from "./config.js";

export type McpServerCli = InstructionCli;

/** A Claude Code `mcpServers` entry (`--mcp-config`, `.mcp.json`). */
export type ClaudeMcpServerEntry =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** An agy `mcp_config.json` entry (what `agy mcp add` writes). */
export type AgyMcpServerEntry =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { serverUrl: string; headers?: Record<string, string> };

export interface McpServersLaunchInput {
  /** The servers to hand out (`McpServerStore.effective(...).enabled`). */
  readonly enabled: readonly { readonly name: string; readonly config: McpServerConfig }[];
  /** Switched off in the winning tier; only reported back. */
  readonly disabled?: readonly { readonly name: string }[];
}

export interface McpServersLaunchOptions {
  /** Where `${NAME}` is read from. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Names the caller hands out itself (its skills server, its own HTTP
   * servers). A ledger server under one of these is skipped and reported, so
   * the caller's entry is the one the CLI gets. `skills` is always reserved.
   */
  readonly reserved?: readonly string[];
}

export interface McpServersLaunch {
  readonly cli: McpServerCli;
  /**
   * Claude: the `mcpServers` entries. Merge them with your own and pass one
   * `--mcp-config` ({@link claudeMcpConfigArgs}). `{}` for the others.
   */
  readonly mcpServers: Record<string, ClaudeMcpServerEntry>;
  /** Codex: `-c mcp_servers.<name>.<key>=<TOML>` overrides. `[]` for the others. */
  readonly args: string[];
  /** agy: the workspace plugin, `relative path → content`, to write under the cwd before it starts. `{}` for the others. */
  readonly files: Record<string, string>;
  /** Names handed to the CLI. */
  readonly delivered: string[];
  /** Names switched off in the ledger (not handed out). */
  readonly disabled: string[];
  /** Names that could not be handed out, and why. Never quotes a value (it may be a secret). */
  readonly skipped: { name: string; reason: string }[];
}

export const AGY_MCP_SERVERS_PLUGIN = "synapse-mcp-servers";

/**
 * A TOML basic string. Not `JSON.stringify`: TOML also forbids a raw DEL
 * (U+007F), and a lone surrogate has no TOML escape at all (throws).
 */
export function tomlBasicString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error("a value contains a lone surrogate, which TOML cannot carry");
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += cp < 0x20 || cp === 0x7f ? `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}` : ch;
    }
  }
  return `${out}"`;
}

const tomlArray = (xs: readonly string[]): string => `[${xs.map(tomlBasicString).join(", ")}]`;
const tomlInlineTable = (m: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(m).map(([k, v]) => `${tomlBasicString(k)} = ${tomlBasicString(v)}`);
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
};

/**
 * Claude Code ignores `cwd` on a stdio entry (2.1.296: the server ran in the
 * session's cwd). The server is started through `/bin/sh` instead, which
 * changes directory and then `exec`s the real command. Every value travels
 * as its own argv element, so nothing is quoted or re-parsed by the shell.
 */
export const CLAUDE_CWD_SHIM = 'cd -- "$1" && shift && exec "$@"';

function claudeEntry(c: McpServerConfig): ClaudeMcpServerEntry {
  if (c.transport === "http") return { type: "http", url: c.url, ...(c.headers ? { headers: { ...c.headers } } : {}) };
  const args = [...(c.args ?? [])];
  const env = c.env ? { env: { ...c.env } } : {};
  if (c.cwd === undefined) return { command: c.command, ...(args.length > 0 ? { args } : {}), ...env };
  return { command: "/bin/sh", args: ["-c", CLAUDE_CWD_SHIM, "synapse-mcp-cwd", c.cwd, c.command, ...args], ...env };
}

function agyEntry(c: McpServerConfig): AgyMcpServerEntry {
  // `serverUrl`: the key `agy mcp add` writes (1.4.0 also reads `url`).
  if (c.transport === "http") return { serverUrl: c.url, ...(c.headers ? { headers: { ...c.headers } } : {}) };
  return {
    command: c.command,
    ...(c.args && c.args.length > 0 ? { args: [...c.args] } : {}),
    ...(c.env ? { env: { ...c.env } } : {}),
    ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
  };
}

/**
 * Codex: one `-c` per key, the same keys as a `[mcp_servers.<name>]` table
 * of `config.toml` (checked against `codex mcp list --json`, 0.163.0). `args`
 * is always sent for stdio so a same-named table in the user's config does
 * not lend its own.
 */
function codexArgs(name: string, c: McpServerConfig): string[] {
  const key = `mcp_servers.${name}`;
  if (c.transport === "http") {
    return [
      "-c",
      `${key}.url=${tomlBasicString(c.url)}`,
      ...(c.headers ? ["-c", `${key}.http_headers=${tomlInlineTable(c.headers)}`] : []),
    ];
  }
  return [
    "-c",
    `${key}.command=${tomlBasicString(c.command)}`,
    "-c",
    `${key}.args=${tomlArray(c.args ?? [])}`,
    ...(c.env ? ["-c", `${key}.env=${tomlInlineTable(c.env)}`] : []),
    ...(c.cwd !== undefined ? ["-c", `${key}.cwd=${tomlBasicString(c.cwd)}`] : []),
  ];
}

const pluginJson = (): string => JSON.stringify({ name: AGY_MCP_SERVERS_PLUGIN }, null, 2) + "\n";

/** agy: the workspace plugin carrying `entries` (`{}` → the withdrawn form). */
export function agyMcpServersPluginFiles(entries: Record<string, AgyMcpServerEntry>): Record<string, string> {
  const dir = `.agents/plugins/${AGY_MCP_SERVERS_PLUGIN}`;
  return {
    [`${dir}/plugin.json`]: pluginJson(),
    [`${dir}/mcp_config.json`]: JSON.stringify({ mcpServers: entries }, null, 2) + "\n",
  };
}

/** The launch inputs for `cli`. No servers → nothing added (agy: no files; see {@link withdrawMcpServersFiles}). */
export function mcpServersLaunch(
  cli: McpServerCli,
  servers: McpServersLaunchInput,
  options: McpServersLaunchOptions = {},
): McpServersLaunch {
  const env = options.env ?? process.env;
  const reserved = new Set([...RESERVED_MCP_SERVER_NAMES, ...(options.reserved ?? [])]);
  const mcpServers: Record<string, ClaudeMcpServerEntry> = {};
  const agy: Record<string, AgyMcpServerEntry> = {};
  const args: string[] = [];
  const delivered: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const { name, config } of servers.enabled) {
    if (!isMcpServerName(name)) {
      skipped.push({ name, reason: "使えない名前（英数字・-・_ だけ、__ は不可）" });
      continue;
    }
    if (reserved.has(name)) {
      skipped.push({ name, reason: "呼び出し側が同じ名前の server を渡す（reserved）" });
      continue;
    }
    if (delivered.includes(name)) {
      skipped.push({ name, reason: "同じ名前が 2 回ある" });
      continue;
    }
    const expanded = expandMcpServerConfig(config, env);
    if (!expanded.ok) {
      skipped.push({
        name,
        reason: expanded.missing.length > 0
          ? `環境変数が無い: ${expanded.missing.join(", ")}`
          : `展開した値が使えない: ${expanded.problem ?? "unknown"}`,
      });
      continue;
    }
    const c = expanded.config;
    switch (cli) {
      case "claude":
        mcpServers[name] = claudeEntry(c);
        break;
      case "codex":
        try {
          args.push(...codexArgs(name, c));
        } catch (e) {
          skipped.push({ name, reason: `Codex の設定（TOML）にできない: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        break;
      case "agy":
        agy[name] = agyEntry(c);
        break;
    }
    delivered.push(name);
  }

  return {
    cli,
    mcpServers,
    args,
    files: cli === "agy" && delivered.length > 0 ? agyMcpServersPluginFiles(agy) : {},
    delivered,
    disabled: (servers.disabled ?? []).map((s) => s.name),
    skipped,
  };
}

/**
 * Claude: one `--mcp-config` for every map given, the first map winning a
 * name (pass your own servers first). `[]` when there is nothing.
 */
export function claudeMcpConfigArgs(...maps: readonly Readonly<Record<string, unknown>>[]): string[] {
  const servers: Record<string, unknown> = {};
  for (const m of maps) for (const [name, entry] of Object.entries(m)) if (!(name in servers)) servers[name] = entry;
  return Object.keys(servers).length === 0 ? [] : ["--mcp-config", JSON.stringify({ mcpServers: servers })];
}

/**
 * The files that take back an earlier delivery, `relative path → content`.
 * Write each only where it already exists. Only agy leaves anything on disk
 * (the plugin, which agy keeps reading until it lists no server).
 */
export function withdrawMcpServersFiles(cli: McpServerCli): Record<string, string> {
  return cli === "agy" ? agyMcpServersPluginFiles({}) : {};
}
