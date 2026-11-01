/**
 * How each CLI is told to start the desktop server (docs/design/desktop-mcp.md).
 * Pure, like the peers registration: returns entries / argv / `path → content`
 * and writes nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tomlBasicString, type McpServerCli } from "../mcp-servers/launch.js";
import type { McpServerEntryConfig } from "../types.js";
import { assertDesktopApiUrl, assertDesktopToken } from "./approval.js";
import { DESKTOP_SERVER_NAME } from "./server.js";

export interface DesktopLaunchOptions {
  /** The approval API's base URL (`http://127.0.0.1:8001`). */
  readonly api: string;
  /** Who asks for access (sent in the access request's body). */
  readonly deskId: string;
  /** Sent as `Authorization: Bearer` to the approval API, when given. */
  readonly token?: string;
  /** The helper's socket. Absolute. Default: `~/Library/Application Support/synapse-desktop/helper.sock`. */
  readonly socket?: string;
  /** The helper .app to start when the socket is missing. Absolute. */
  readonly helperApp?: string;
  /** JSONL log of tool calls (no images, no typed text). Absolute. */
  readonly log?: string;
  /** How long one request_access waits for the person. Default 45 s. */
  readonly approvalTimeoutMs?: number;
  /** The server's name in the CLI (`mcp__<name>__screenshot`). Default `desktop`. */
  readonly name?: string;
  readonly node?: string;
  readonly cli?: string;
}

export const AGY_DESKTOP_PLUGIN = "synapse-desktop";

function defaultCli(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

function abs(what: string, p: string | undefined): void {
  if (p !== undefined && !path.isAbsolute(p)) throw new Error(`desktop ${what} path must be absolute: ${p}`);
}

/** `{ command, args }` that starts one desktop server for one session. */
export function desktopServerEntry(o: DesktopLaunchOptions): McpServerEntryConfig {
  assertDesktopApiUrl(o.api);
  assertDesktopToken(o.deskId, "deskId");
  if (o.token !== undefined) assertDesktopToken(o.token);
  abs("socket", o.socket);
  abs("helperApp", o.helperApp);
  abs("log", o.log);
  if (o.approvalTimeoutMs !== undefined && !(Number.isInteger(o.approvalTimeoutMs) && o.approvalTimeoutMs > 0)) {
    throw new Error(`desktop approvalTimeoutMs must be a positive integer: ${o.approvalTimeoutMs}`);
  }
  const args = [o.cli ?? defaultCli(), "serve", "--api", o.api, "--desk-id", o.deskId];
  if (o.token !== undefined) args.push("--token", o.token);
  if (o.socket !== undefined) args.push("--socket", o.socket);
  if (o.helperApp !== undefined) args.push("--helper-app", o.helperApp);
  if (o.log !== undefined) args.push("--log", o.log);
  if (o.approvalTimeoutMs !== undefined) args.push("--approval-timeout-ms", String(o.approvalTimeoutMs));
  return { command: o.node ?? process.execPath, args };
}

function serverName(o: DesktopLaunchOptions): string {
  const name = o.name ?? DESKTOP_SERVER_NAME;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`desktop server name must be [A-Za-z0-9_-]+: ${name}`);
  return name;
}

/** Claude Code: `{ desktop: entry }`, to merge into one `--mcp-config` (`claudeMcpConfigArgs`). */
export function claudeDesktopMcpServers(o: DesktopLaunchOptions): Record<string, McpServerEntryConfig> {
  return { [serverName(o)]: desktopServerEntry(o) };
}

/** Codex: `-c mcp_servers.desktop.command=…` `-c mcp_servers.desktop.args=[…]`. */
export function codexDesktopConfigArgs(o: DesktopLaunchOptions): string[] {
  const e = desktopServerEntry(o);
  const key = `mcp_servers.${serverName(o)}`;
  return ["-c", `${key}.command=${tomlBasicString(e.command)}`, "-c", `${key}.args=[${(e.args ?? []).map(tomlBasicString).join(", ")}]`];
}

function agyPlugin(servers: Record<string, McpServerEntryConfig>): Record<string, string> {
  const dir = `.agents/plugins/${AGY_DESKTOP_PLUGIN}`;
  return {
    [`${dir}/plugin.json`]: JSON.stringify({ name: AGY_DESKTOP_PLUGIN }, null, 2) + "\n",
    [`${dir}/mcp_config.json`]: JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
  };
}

/** agy: the workspace plugin `.agents/plugins/synapse-desktop/`. Write it 0600 when it carries a token. */
export function agyDesktopPluginFiles(o: DesktopLaunchOptions): Record<string, string> {
  return agyPlugin(claudeDesktopMcpServers(o));
}

/** Takes back an earlier delivery. Only agy leaves anything on disk. */
export function withdrawDesktopFiles(cli: McpServerCli): Record<string, string> {
  return cli === "agy" ? agyPlugin({}) : {};
}
