#!/usr/bin/env node
/**
 * `synapse-mcp-servers` — the management CLI of the MCP server ledger
 * (docs/design/mcp-servers.md).
 *
 *   synapse-mcp-servers list    [--effective --agent A [--desk D]]
 *   synapse-mcp-servers show    <name> [--global | --agent A [--desk D]] [--effective]
 *   synapse-mcp-servers put     <file.json> (--global | --agent A [--desk D]) [--dry-run]
 *   synapse-mcp-servers rm      <name> (--global | --agent A [--desk D])
 *   synapse-mcp-servers history <name>
 *   synapse-mcp-servers launch  <claude|codex|agy> [--agent A [--desk D]]
 *
 * Every command takes `--db <abs path>` (else $SYNAPSE_SKILLS_DB, else
 * ~/.local/share/synapse-skills/skills.db) — the same file as the skills.
 * Writes name their tier explicitly: nothing writes "everyone" by omission.
 *
 * `put` reads one server as JSON:
 *   {"name": "artiflow", "transport": "stdio", "command": "node", "args": ["…"],
 *    "env": {"API_TOKEN": "${ARTIFLOW_TOKEN}"}, "cwd": "/abs", "enabled": true}
 *   {"name": "yatagarasu", "transport": "http", "url": "${YATAGARASU_URL}",
 *    "headers": {"Authorization": "Bearer ${YATAGARASU_TOKEN}"}}
 * `${NAME}` is expanded from the environment at launch; `$${` is a literal `${`.
 *
 * `launch` prints, as JSON, what the CLI would get, with `${NAME}` expanded
 * from this process's environment (so it may print secrets).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaultSkillsDbPath } from "../skills/registration.js";
import { GLOBAL_SCOPE, agentScope, describeScope, deskScope, type SkillScope } from "../skills/scope.js";
import { isInstructionCli } from "../instructions/launch.js";
import { parseMcpServerSpec, plaintextSecretKeys } from "./config.js";
import { mcpServersLaunch } from "./launch.js";
import { McpServerStore, type McpServerRecord } from "./store.js";

const OPTIONS = {
  db: { type: "string" },
  agent: { type: "string" },
  desk: { type: "string" },
  global: { type: "boolean" },
  effective: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

function usage(): string {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8");
  const m = /\/\*\*\n([\s\S]*?)\*\//.exec(src);
  return (m?.[1] ?? "").replace(/^ \* ?/gm, "");
}

function dbPath(v: Values, env: NodeJS.ProcessEnv): string {
  return path.resolve(v.db ?? env.SYNAPSE_SKILLS_DB ?? defaultSkillsDbPath(env));
}

/** `--agent` / `--desk` as a scope, or `undefined` when neither is given. */
function scopeOf(v: Values): SkillScope | undefined {
  if (v.desk !== undefined && v.agent === undefined) throw new UsageError("--desk には --agent が要る");
  if (v.agent === undefined) return undefined;
  return v.desk === undefined ? agentScope(v.agent) : deskScope(v.agent, v.desk);
}

/** The tier a write names: must be named. */
function targetOf(v: Values): SkillScope {
  const scope = scopeOf(v);
  if (v.global && scope) throw new UsageError("--global と --agent は同時に使えない");
  if (v.global) return GLOBAL_SCOPE;
  if (!scope) throw new UsageError("階層を --global か --agent <名前>（と --desk <名前>）で指定する");
  return scope;
}

function line(r: McpServerRecord): string {
  return [
    describeScope(r.scope),
    r.name,
    `v${r.version}`,
    r.config.transport,
    r.enabled ? "on" : "off",
    r.createdAt,
    r.author,
  ].join("\t");
}

/** The record as a `put` file (what `show` prints). */
function asSpec(r: McpServerRecord): Record<string, unknown> {
  return { name: r.name, enabled: r.enabled, ...r.config };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...rest] = positionals;
  if (v.help || cmd === undefined || cmd === "help") {
    process.stdout.write(usage());
    return cmd === undefined && !v.help ? 1 : 0;
  }

  // Validate before opening (and so creating) the store.
  if (cmd === "put") {
    const file = path.resolve(one(rest, "put <file.json>"));
    const target = targetOf(v);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new UsageError(`${file} を JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { name, enabled, ...config } = parseMcpServerSpec(raw);
    for (const key of plaintextSecretKeys(config)) {
      err(`warning: ${name} の ${key} は値がそのまま書かれている。秘密なら \${環境変数} で参照する`);
    }
    if (v["dry-run"]) {
      out(`would put ${name} (${config.transport}, ${enabled ? "on" : "off"}) → ${describeScope(target)}`);
      return 0;
    }
    return withStore(v, env, (store) => {
      const { record, changed } = store.put(target, { name, config, enabled, author: "cli:put" });
      out(`${changed ? "put" : "unchanged"} ${name} → ${describeScope(target)} v${record.version}`);
      return 0;
    });
  }

  return withStore(v, env, (store) => {
    switch (cmd) {
      case "list": {
        if (v.effective) {
          const viewer = scopeOf(v);
          if (!viewer) throw new UsageError("--effective には --agent（と --desk）を付ける");
          const eff = store.effective(viewer);
          for (const r of [...eff.enabled, ...eff.disabled].sort((a, b) => a.name.localeCompare(b.name))) out(line(r));
          return 0;
        }
        for (const r of store.listAll()) out(line(r));
        return 0;
      }

      case "show": {
        const name = one(rest, "show <name>");
        let rec: McpServerRecord | undefined;
        if (v.effective) {
          const viewer = scopeOf(v);
          if (!viewer) throw new UsageError("--effective には --agent（と --desk）を付ける");
          rec = store.resolve(viewer, name);
          if (!rec) throw new UsageError(`${describeScope(viewer)} には ${name} が無い`);
          err(`# ${describeScope(rec.scope)} v${rec.version}`);
        } else {
          const scope = v.agent === undefined && v.desk === undefined ? GLOBAL_SCOPE : targetOf(v);
          const latest = store.latestIn(scope, name);
          rec = latest && !latest.deleted ? latest : undefined;
          if (!rec) throw new UsageError(`${describeScope(scope)} に ${name} は無い`);
        }
        out(JSON.stringify(asSpec(rec), null, 2));
        return 0;
      }

      case "rm": {
        const name = one(rest, "rm <name>");
        const scope = targetOf(v);
        const tomb = store.remove(scope, name, "cli:rm");
        if (!tomb) throw new UsageError(`${describeScope(scope)} に ${name} は無い`);
        out(`removed ${name} from ${describeScope(scope)} (tombstone v${tomb.version})`);
        return 0;
      }

      case "history": {
        const name = one(rest, "history <name>");
        for (const r of store.history(name)) {
          out([`v${r.version}`, r.deleted ? "deleted" : "live", describeScope(r.scope), r.config.transport, r.enabled ? "on" : "off", r.createdAt, r.author].join("\t"));
        }
        return 0;
      }

      case "launch": {
        const cli = one(rest, "launch <claude|codex|agy>");
        if (!isInstructionCli(cli)) throw new UsageError(`unknown CLI: ${cli}`);
        const viewer = scopeOf(v) ?? GLOBAL_SCOPE;
        out(JSON.stringify(mcpServersLaunch(cli, store.effective(viewer), { env }), null, 2));
        return 0;
      }

      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  });
}

function withStore(v: Values, env: NodeJS.ProcessEnv, fn: (store: McpServerStore) => number): number {
  const store = McpServerStore.open(dbPath(v, env));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function one(rest: string[], what: string): string {
  if (rest.length !== 1) throw new UsageError(`usage: synapse-mcp-servers ${what}`);
  return rest[0]!;
}

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

const isEntry = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (e: unknown) => {
      err(`synapse-mcp-servers: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
