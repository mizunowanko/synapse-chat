#!/usr/bin/env node
/**
 * `synapse-desktop` — the desktop MCP server (docs/design/desktop-mcp.md).
 *
 *   synapse-desktop serve    --api <url> --desk-id <id> [--token <t>] [--socket <path>] [--helper-app <app>] [--log <file>] [--approval-timeout-ms <n>]
 *   synapse-desktop register <claude|codex|agy> --api <url> --desk-id <id> [same options] [--out <dir>]
 *   synapse-desktop status   [--socket <path>] [--helper-app <app>]      ask the helper (starts it if needed)
 *
 * serve is a stdio MCP server, one per CLI session. It asks the approval API
 * at <url> for access and talks to the native helper over its Unix socket
 * (started with `open -g -a` when the socket is missing).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createApprovalClient } from "./approval.js";
import { createHelperClient } from "./helper-client.js";
import { agyDesktopPluginFiles, claudeDesktopMcpServers, codexDesktopConfigArgs, desktopServerEntry, type DesktopLaunchOptions } from "./registration.js";
import { createDesktopMcpServer } from "./server.js";

const OPTIONS = {
  api: { type: "string" },
  "desk-id": { type: "string" },
  token: { type: "string" },
  socket: { type: "string" },
  "helper-app": { type: "string" },
  log: { type: "string" },
  "approval-timeout-ms": { type: "string" },
  out: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

function usage(): string {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8");
  const m = /\/\*\*\n([\s\S]*?)\*\//.exec(src);
  return (m?.[1] ?? "").replace(/^ \* ?/gm, "");
}

function launchOf(v: Values): DesktopLaunchOptions {
  if (!v.api) throw new UsageError("--api <url> が要る");
  if (!v["desk-id"]) throw new UsageError("--desk-id <id> が要る");
  let approvalTimeoutMs: number | undefined;
  if (v["approval-timeout-ms"] !== undefined) {
    approvalTimeoutMs = Number(v["approval-timeout-ms"]);
    if (!Number.isInteger(approvalTimeoutMs) || approvalTimeoutMs <= 0) throw new UsageError("--approval-timeout-ms は正の整数");
  }
  const launch: DesktopLaunchOptions = {
    api: v.api,
    deskId: v["desk-id"],
    ...(v.token ? { token: v.token } : {}),
    ...(v.socket ? { socket: path.resolve(v.socket) } : {}),
    ...(v["helper-app"] ? { helperApp: path.resolve(v["helper-app"]) } : {}),
    ...(v.log ? { log: path.resolve(v.log) } : {}),
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
  };
  try {
    desktopServerEntry(launch);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  return launch;
}

function helperOf(v: Values) {
  return createHelperClient({
    ...(v.socket ? { socketPath: path.resolve(v.socket) } : {}),
    ...(v["helper-app"] ? { helperApp: path.resolve(v["helper-app"]) } : {}),
  });
}

export async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...rest] = positionals;
  if (v.help || cmd === undefined || cmd === "help") {
    process.stdout.write(usage());
    return cmd === undefined && !v.help ? 1 : 0;
  }

  if (cmd === "serve") {
    if (rest.length > 0) throw new UsageError("serve は位置引数を取らない");
    const launch = launchOf(v);
    const approval = createApprovalClient({ api: launch.api, ...(launch.token ? { token: launch.token } : {}) });
    const server = createDesktopMcpServer({
      approval,
      helper: helperOf(v),
      deskId: launch.deskId,
      ...(launch.log ? { logFile: launch.log } : {}),
      ...(launch.approvalTimeoutMs ? { approvalTimeoutMs: launch.approvalTimeoutMs } : {}),
    });
    await server.start();
    await new Promise<void>((resolve) => process.stdin.on("close", resolve));
    await server.stop();
    return 0;
  }

  if (cmd === "status") {
    const helper = helperOf(v);
    const r = await helper.request("status");
    helper.close();
    out(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }

  if (cmd === "register") {
    const [cli, ...extra] = rest;
    if (cli === undefined || extra.length > 0) throw new UsageError("register <claude|codex|agy>");
    const launch = launchOf(v);
    if (cli === "claude") {
      out(JSON.stringify({ mcpServers: claudeDesktopMcpServers(launch) }, null, 2));
    } else if (cli === "codex") {
      out(codexDesktopConfigArgs(launch).map((a) => JSON.stringify(a)).join(" "));
    } else if (cli === "agy") {
      const files = agyDesktopPluginFiles(launch);
      if (!v.out) {
        out(JSON.stringify(files, null, 2));
      } else {
        for (const [rel, content] of Object.entries(files)) {
          const p = path.join(path.resolve(v.out), rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content, { mode: 0o600 });
          out(`wrote ${p}`);
        }
      }
    } else {
      throw new UsageError(`unknown CLI: ${cli}（claude / codex / agy）`);
    }
    return 0;
  }

  throw new UsageError(`unknown command: ${cmd}`);
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}

const isEntry = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (e: unknown) => {
      // Never echo the arguments: one of them may be the token.
      process.stderr.write(`synapse-desktop: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
