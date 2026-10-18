#!/usr/bin/env node
/**
 * `synapse-peers` — the peers MCP server (docs/design/peers-mcp.md).
 *
 *   synapse-peers serve    --api <url> --token <t> [--log <file>] [--timeout-ms <n>]   stdio MCP server, one per CLI session
 *   synapse-peers register <claude|codex|agy> --api <url> --token <t> [--log <file>] [--out <dir>]
 *
 * The token and the URL are launch arguments only (never environment
 * variables: those leak into every process the session starts). `register`
 * prints what a CLI would be given; the app normally builds it with the
 * registration functions of `@synapse-chat/mcp/peers`.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createPeersClient } from "./client.js";
import { agyPeersPluginFiles, claudePeersMcpConfig, codexPeersConfigArgs, type PeersLaunchOptions } from "./registration.js";
import { createPeersMcpServer } from "./server.js";

const OPTIONS = {
  api: { type: "string" },
  token: { type: "string" },
  log: { type: "string" },
  "timeout-ms": { type: "string" },
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

function launchOf(v: Values): PeersLaunchOptions {
  if (!v.api) throw new UsageError("--api <url> が要る");
  if (!v.token) throw new UsageError("--token <t> が要る");
  let timeoutMs: number | undefined;
  if (v["timeout-ms"] !== undefined) {
    timeoutMs = Number(v["timeout-ms"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new UsageError("--timeout-ms は正の整数");
  }
  return {
    api: v.api,
    token: v.token,
    ...(v.log ? { log: path.resolve(v.log) } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
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
    let client;
    try {
      client = createPeersClient(launch);
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e));
    }
    const server = createPeersMcpServer({ client, ...(launch.log ? { logFile: launch.log } : {}) });
    await server.start();
    await new Promise<void>((resolve) => process.stdin.on("close", resolve));
    return 0;
  }

  if (cmd === "register") {
    const [cli, ...extra] = rest;
    if (cli === undefined || extra.length > 0) throw new UsageError("register <claude|codex|agy>");
    const launch = launchOf(v);
    if (cli === "claude") {
      out(JSON.stringify(claudePeersMcpConfig(launch), null, 2));
    } else if (cli === "codex") {
      out(codexPeersConfigArgs(launch).map((a) => JSON.stringify(a)).join(" "));
    } else if (cli === "agy") {
      const files = agyPeersPluginFiles(launch);
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
      // Never echo the arguments: one of them is the token.
      process.stderr.write(`synapse-peers: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
