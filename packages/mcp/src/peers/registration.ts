/**
 * How each CLI is told to start the peers server (docs/design/peers-mcp.md).
 * Pure: returns entries / argv / `path → content`; the caller decides where to
 * put them, merged with its own servers. Nothing here writes a file or touches
 * user-wide config (`~/.claude`, `~/.codex`, `~/.gemini`).
 *
 * The token is in every value returned here (it is a launch argument by
 * design). Logging a launch line, or committing the agy plugin, leaks it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tomlBasicString, type McpServerCli } from "../mcp-servers/launch.js";
import type { McpServerEntryConfig } from "../types.js";
import { assertPeersApiUrl, assertPeersToken } from "./client.js";
import { PEERS_SERVER_NAME } from "./server.js";

export interface PeersLaunchOptions {
  /** The app's base URL (`http://127.0.0.1:8001`). */
  readonly api: string;
  /** The token that names this session to the app. One per session. */
  readonly token: string;
  /** JSONL log of tool calls (no token, no message text). Absolute: the server's cwd differs per CLI. */
  readonly log?: string;
  /** How long one call to the app may take. Default 45 s (below Codex's 60 s tool timeout). */
  readonly timeoutMs?: number;
  /** The Node binary. Default: the one running this code. */
  readonly node?: string;
  /** The server script. Default: this package's `dist/peers/cli.js`. */
  readonly cli?: string;
}

/** The agy workspace plugin that carries the peers server. Its own, so it never collides with the ledger's or the skills'. */
export const AGY_PEERS_PLUGIN = "synapse-peers";

function defaultCli(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/** `{ command, args }` that starts one peers server for one session. */
export function peersServerEntry(o: PeersLaunchOptions): McpServerEntryConfig {
  assertPeersApiUrl(o.api);
  assertPeersToken(o.token);
  if (o.log !== undefined && !path.isAbsolute(o.log)) throw new Error(`peers log path must be absolute: ${o.log}`);
  if (o.timeoutMs !== undefined && !(Number.isInteger(o.timeoutMs) && o.timeoutMs > 0)) {
    throw new Error(`peers timeoutMs must be a positive integer: ${o.timeoutMs}`);
  }
  const args = [o.cli ?? defaultCli(), "serve", "--api", o.api, "--token", o.token];
  if (o.log !== undefined) args.push("--log", o.log);
  if (o.timeoutMs !== undefined) args.push("--timeout-ms", String(o.timeoutMs));
  return { command: o.node ?? process.execPath, args };
}

/**
 * Claude Code: `{ peers: entry }`, to merge with your other servers into one
 * `--mcp-config` (`claudeMcpConfigArgs` of `@synapse-chat/mcp/mcp-servers`).
 */
export function claudePeersMcpServers(o: PeersLaunchOptions): Record<string, McpServerEntryConfig> {
  return { [PEERS_SERVER_NAME]: peersServerEntry(o) };
}

/** Claude Code: the whole JSON for `claude --mcp-config <file|json>`, when peers is the only server. */
export function claudePeersMcpConfig(o: PeersLaunchOptions): { mcpServers: Record<string, McpServerEntryConfig> } {
  return { mcpServers: claudePeersMcpServers(o) };
}

/** Codex: `-c` overrides for `codex` / `codex exec` / `codex app-server` (the keys of `[mcp_servers.peers]`). */
export function codexPeersConfigArgs(o: PeersLaunchOptions): string[] {
  const e = peersServerEntry(o);
  const key = `mcp_servers.${PEERS_SERVER_NAME}`;
  return [
    "-c",
    `${key}.command=${tomlBasicString(e.command)}`,
    "-c",
    `${key}.args=[${(e.args ?? []).map(tomlBasicString).join(", ")}]`,
  ];
}

function agyPlugin(servers: Record<string, McpServerEntryConfig>): Record<string, string> {
  const dir = `.agents/plugins/${AGY_PEERS_PLUGIN}`;
  return {
    [`${dir}/plugin.json`]: JSON.stringify({ name: AGY_PEERS_PLUGIN }, null, 2) + "\n",
    [`${dir}/mcp_config.json`]: JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
  };
}

/**
 * agy: the workspace plugin `.agents/plugins/synapse-peers/{plugin.json,mcp_config.json}`,
 * relative to the cwd agy starts in. agy starts the server with the plugin
 * directory as its cwd, so every path in it is absolute. The token is in
 * `mcp_config.json`: write it with owner-only permissions and keep it out of git.
 */
export function agyPeersPluginFiles(o: PeersLaunchOptions): Record<string, string> {
  return agyPlugin(claudePeersMcpServers(o));
}

/**
 * The files that take back an earlier delivery (a session that must not get
 * the peers server), `relative path → content`. Write each only where it
 * already exists. Only agy leaves anything on disk.
 */
export function withdrawPeersFiles(cli: McpServerCli): Record<string, string> {
  return cli === "agy" ? agyPlugin({}) : {};
}
