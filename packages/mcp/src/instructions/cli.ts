#!/usr/bin/env node
/**
 * `synapse-instructions` — the management CLI of the instruction store
 * (docs/design/instructions.md).
 *
 *   synapse-instructions list
 *   synapse-instructions show    [--global | --agent A] [--effective]
 *   synapse-instructions import  <file> (--global | --agent A) [--dry-run]
 *   synapse-instructions export  (--global | --agent A) --out <file> [--force]
 *   synapse-instructions rm      (--global | --agent A)
 *   synapse-instructions history (--global | --agent A)
 *   synapse-instructions launch  <claude|codex|agy> --cwd <dir> [--agent A [--desk D]] [--replace <dir>]...
 *
 * Every command takes `--db <abs path>` (else $SYNAPSE_SKILLS_DB, else
 * ~/.local/share/synapse-skills/skills.db) — the same file as the skills.
 * Writes name their tier explicitly: nothing writes "everyone" by omission.
 *
 * `launch` also carries, under `mcp`, the MCP servers of the ledger
 * (`synapse-mcp-servers`, docs/design/mcp-servers.md) as that CLI takes them,
 * with `${NAME}` expanded from this process's environment. They are not
 * merged into `args` / `files`: the caller adds its own servers first.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { mcpServersLaunch } from "../mcp-servers/launch.js";
import { McpServerStore } from "../mcp-servers/store.js";
import { defaultSkillsDbPath } from "../skills/registration.js";
import { GLOBAL_SCOPE, agentScope, deskScope } from "../skills/scope.js";
import { instructionsLaunch, isInstructionCli } from "./launch.js";
import { effectiveInstructions, readInstructionFile } from "./render.js";
import {
  GLOBAL_INSTRUCTIONS,
  InstructionStore,
  agentInstructions,
  describeInstructionScope,
  type InstructionScope,
} from "./store.js";

const OPTIONS = {
  db: { type: "string" },
  agent: { type: "string" },
  desk: { type: "string" },
  global: { type: "boolean" },
  effective: { type: "boolean" },
  out: { type: "string" },
  force: { type: "boolean" },
  cwd: { type: "string" },
  replace: { type: "string", multiple: true },
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

/** The tier a command reads or writes: must be named. */
function targetOf(v: Values): InstructionScope {
  if (v.global && v.agent !== undefined) throw new UsageError("--global と --agent は同時に使えない");
  if (v.global) return GLOBAL_INSTRUCTIONS;
  if (v.agent === undefined) throw new UsageError("階層を --global か --agent <名前> で指定する");
  return agentInstructions(v.agent);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...rest] = positionals;
  if (v.help || cmd === undefined || cmd === "help") {
    process.stdout.write(usage());
    return cmd === undefined && !v.help ? 1 : 0;
  }

  // Validate before opening (and so creating) the store.
  if (cmd === "import") {
    const file = path.resolve(one(rest, "import <file>"));
    const target = targetOf(v);
    const body = readInstructionFile(file);
    if (body === "") throw new UsageError(`${file} は空`);
    if (v["dry-run"]) {
      out(`would import ${file} (${Buffer.byteLength(body)} bytes) → ${describeInstructionScope(target)}`);
      return 0;
    }
    return withStore(v, env, (store) => {
      const { record, changed } = store.put(target, body, "cli:import");
      out(`${changed ? "imported" : "unchanged"} ${describeInstructionScope(target)} v${record.version} (${Buffer.byteLength(body)} bytes)`);
      return 0;
    });
  }

  return withStore(v, env, (store) => {
    switch (cmd) {
      case "list": {
        for (const r of store.list()) {
          out(`${describeInstructionScope(r.scope)}\tv${r.version}\t${Buffer.byteLength(r.body)} bytes\t${r.createdAt}\t${r.author}`);
        }
        return 0;
      }

      case "show": {
        if (v.effective) {
          if (v.global) throw new UsageError("--effective には --agent を付ける（--global は全員の階層そのもの）");
          const eff = effectiveInstructions(store, v.agent);
          if (eff.text === "") throw new UsageError("指示書が無い");
          process.stdout.write(eff.text);
          return 0;
        }
        const scope = v.agent === undefined ? GLOBAL_INSTRUCTIONS : targetOf(v);
        const rec = store.get(scope);
        if (!rec) throw new UsageError(`${describeInstructionScope(scope)} の指示書は無い`);
        process.stdout.write(rec.body);
        return 0;
      }

      case "export": {
        if (!v.out) throw new UsageError("export には --out <file> が要る");
        const scope = targetOf(v);
        const rec = store.get(scope);
        if (!rec) throw new UsageError(`${describeInstructionScope(scope)} の指示書は無い`);
        const file = path.resolve(v.out);
        if (fs.existsSync(file) && !v.force) throw new UsageError(`${file} がある（上書きするなら --force）`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, rec.body);
        out(`exported ${describeInstructionScope(scope)} v${rec.version} → ${file}`);
        return 0;
      }

      case "rm": {
        const scope = targetOf(v);
        const tomb = store.remove(scope, "cli:rm");
        if (!tomb) throw new UsageError(`${describeInstructionScope(scope)} の指示書は無い`);
        out(`removed ${describeInstructionScope(scope)} (tombstone v${tomb.version})`);
        return 0;
      }

      case "history": {
        const scope = targetOf(v);
        for (const r of store.history(scope)) {
          out(`v${r.version}\t${r.deleted ? "deleted" : "live"}\t${Buffer.byteLength(r.body)} bytes\t${r.createdAt}\t${r.author}`);
        }
        return 0;
      }

      case "launch": {
        const cli = one(rest, "launch <claude|codex|agy>");
        if (!isInstructionCli(cli)) throw new UsageError(`unknown CLI: ${cli}`);
        if (!v.cwd) throw new UsageError("launch には --cwd <dir> が要る");
        if (v.desk !== undefined && v.agent === undefined) throw new UsageError("--desk には --agent が要る");
        const eff = effectiveInstructions(store, v.agent);
        const launch = instructionsLaunch(cli, {
          text: eff.text,
          cwd: path.resolve(v.cwd),
          replaces: (v.replace ?? []).map((d) => path.resolve(d)),
        });
        const viewer = v.agent === undefined
          ? GLOBAL_SCOPE
          : v.desk === undefined ? agentScope(v.agent) : deskScope(v.agent, v.desk);
        const servers = McpServerStore.open(dbPath(v, env));
        try {
          const mcp = mcpServersLaunch(cli, servers.effective(viewer), { env });
          out(JSON.stringify({ ...launch, mcp }, null, 2));
        } finally {
          servers.close();
        }
        return 0;
      }

      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  });
}

function withStore(v: Values, env: NodeJS.ProcessEnv, fn: (store: InstructionStore) => number): number {
  const store = InstructionStore.open(dbPath(v, env));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function one(rest: string[], what: string): string {
  if (rest.length !== 1) throw new UsageError(`usage: synapse-instructions ${what}`);
  return rest[0]!;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

const isEntry = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (e: unknown) => {
      err(`synapse-instructions: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
