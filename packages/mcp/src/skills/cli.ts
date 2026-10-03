#!/usr/bin/env node
/**
 * `synapse-skills` — the skills server and its management CLI
 * (docs/design/skills-mcp.md).
 *
 *   synapse-skills serve    [--agent A [--desk D]] [--read-only]   stdio MCP server, one per CLI session
 *   synapse-skills list     [--agent A [--desk D] | --global] [--tier]
 *   synapse-skills show     <name> [--agent A [--desk D]]
 *   synapse-skills import   <dir...> (--global | --agent A [--desk D]) [--dry-run]
 *   synapse-skills export   <name...> | --all  --out <dir> [--agent A [--desk D]] [--force]
 *   synapse-skills rm       <name> (--global | --agent A [--desk D])
 *   synapse-skills history  <name>
 *   synapse-skills register <claude|codex|agy> [--agent A [--desk D]] [--out <dir>]
 *
 * Every command takes `--db <abs path>` (else $SYNAPSE_SKILLS_DB, else
 * ~/.local/share/synapse-skills/skills.db).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaultCacheRoot } from "./materialize.js";
import {
  agySkillsPluginFiles,
  claudeSkillsMcpConfig,
  codexSkillsConfigToml,
  defaultSkillsDbPath,
} from "./registration.js";
import { GLOBAL_SCOPE, agentScope, deskScope, describeScope, tierOf, type SkillScope } from "./scope.js";
import { createSkillsMcpServer } from "./server.js";
import { findSkillDirs, readSkillDir, renderSkillMd, writeSkillDir } from "./skill-dir.js";
import { SkillStore } from "./store.js";

const OPTIONS = {
  db: { type: "string" },
  agent: { type: "string" },
  desk: { type: "string" },
  global: { type: "boolean" },
  tier: { type: "boolean" },
  all: { type: "boolean" },
  out: { type: "string" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  "read-only": { type: "boolean" },
  "cache-dir": { type: "string" },
  log: { type: "string" },
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
  const p = v.db ?? env.SYNAPSE_SKILLS_DB ?? defaultSkillsDbPath(env);
  return path.resolve(p);
}

/** The viewer for read commands: no flags = the everyone tier only. */
function viewerOf(v: Values): SkillScope {
  if (v.desk !== undefined && v.agent === undefined) throw new UsageError("--desk には --agent が要る");
  if (v.agent === undefined) return GLOBAL_SCOPE;
  return v.desk === undefined ? agentScope(v.agent) : deskScope(v.agent, v.desk);
}

/** The target tier of a write: must be named explicitly, so nobody writes "everyone" by omission. */
function targetOf(v: Values): SkillScope {
  if (v.global && v.agent !== undefined) throw new UsageError("--global と --agent は同時に使えない");
  if (v.global) return GLOBAL_SCOPE;
  if (v.agent === undefined) throw new UsageError("書き込む階層を --global か --agent <名前> で指定する");
  return viewerOf(v);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...rest] = positionals;
  if (v.help || cmd === undefined || cmd === "help") {
    process.stdout.write(usage());
    return cmd === undefined && !v.help ? 1 : 0;
  }

  if (cmd === "register") return register(v, rest, env);

  const store = SkillStore.open(dbPath(v, env));
  try {
    switch (cmd) {
      case "serve": {
        const server = createSkillsMcpServer({
          store,
          viewer: viewerOf(v),
          cacheRoot: v["cache-dir"] ? path.resolve(v["cache-dir"]) : defaultCacheRoot(env),
          writable: !v["read-only"],
          ...(v.log ? { logFile: path.resolve(v.log) } : {}),
        });
        await server.start();
        // stdio keeps the process alive; the store closes with the process.
        await new Promise<void>((resolve) => process.stdin.on("close", resolve));
        return 0;
      }

      case "list": {
        const scope = v.global ? GLOBAL_SCOPE : viewerOf(v);
        const skills = v.tier ? store.listIn(scope) : store.list(scope);
        for (const s of skills) {
          out(`${s.name}\tv${s.version}\t${describeScope(s.scope)}\t${s.description.replace(/\s+/g, " ")}`);
        }
        return 0;
      }

      case "show": {
        const name = one(rest, "show <name>");
        const rec = store.resolve(viewerOf(v), name);
        if (!rec) throw new UsageError(`${name} は無い`);
        out(`# ${rec.name} v${rec.version}（${describeScope(rec.scope)}）`);
        for (const f of store.files(rec)) out(`# file: ${f.path} (${(f.mode & 0o777).toString(8)})`);
        out(renderSkillMd(rec));
        return 0;
      }

      case "import": {
        if (rest.length === 0) throw new UsageError("import <dir...>");
        const target = targetOf(v);
        const dirs = rest.flatMap((d) => findSkillDirs(path.resolve(d)));
        if (dirs.length === 0) throw new UsageError(`SKILL.md のあるディレクトリが見つからない: ${rest.join(" ")}`);
        for (const dir of dirs) {
          const { input, skipped } = readSkillDir(dir);
          for (const s of skipped) err(`  skip ${input.name}/${s}`);
          if (v["dry-run"]) {
            out(`would import ${input.name} (${input.files.length} files) → ${describeScope(target)}`);
            continue;
          }
          const { record, changed } = store.put(target, { ...input, author: "cli:import" });
          out(`${changed ? "imported" : "unchanged"} ${record.name} v${record.version} → ${describeScope(target)} (${input.files.length} files)`);
        }
        return 0;
      }

      case "export": {
        if (!v.out) throw new UsageError("export には --out <dir> が要る");
        const viewer = viewerOf(v);
        const recs = v.all
          ? store.list(viewer)
          : rest.map((n) => {
              const r = store.resolve(viewer, n);
              if (!r) throw new UsageError(`${n} は無い`);
              return r;
            });
        if (recs.length === 0) throw new UsageError("書き出すスキルが無い（名前か --all）");
        for (const r of recs) {
          const dir = path.join(path.resolve(v.out), r.name);
          writeSkillDir(dir, r, store.files(r), { force: v.force === true });
          out(`exported ${r.name} v${r.version} → ${dir}`);
        }
        return 0;
      }

      case "rm": {
        const name = one(rest, "rm <name>");
        const target = targetOf(v);
        const tomb = store.remove(target, name, "cli:rm");
        if (!tomb) throw new UsageError(`${describeScope(target)} の階層に ${name} は無い`);
        out(`removed ${name} from ${describeScope(target)} (tombstone v${tomb.version})`);
        const now = store.resolve(target, name);
        if (now) out(`  いまは ${describeScope(now.scope)} の v${now.version} が見える`);
        return 0;
      }

      case "history": {
        const name = one(rest, "history <name>");
        for (const r of store.history(name)) {
          out(`v${r.version}\t${r.deleted ? "deleted" : "live"}\t${tierOf(r.scope)}\t${describeScope(r.scope)}\t${r.createdAt}\t${r.author}`);
        }
        return 0;
      }

      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

function register(v: Values, rest: string[], env: NodeJS.ProcessEnv): number {
  const cli = one(rest, "register <claude|codex|agy>");
  viewerOf(v); // validates --agent / --desk
  const launch = {
    db: dbPath(v, env),
    ...(v.agent !== undefined ? { agent: v.agent } : {}),
    ...(v.desk !== undefined ? { desk: v.desk } : {}),
    ...(v["read-only"] ? { readOnly: true } : {}),
    ...(v["cache-dir"] ? { cacheDir: path.resolve(v["cache-dir"]) } : {}),
    ...(v.log ? { log: path.resolve(v.log) } : {}),
  };
  if (cli === "claude") {
    out(JSON.stringify(claudeSkillsMcpConfig(launch), null, 2));
  } else if (cli === "codex") {
    process.stdout.write(codexSkillsConfigToml(launch));
  } else if (cli === "agy") {
    const files = agySkillsPluginFiles(launch);
    if (!v.out) {
      out(JSON.stringify(files, null, 2));
    } else {
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(path.resolve(v.out), rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        out(`wrote ${p}`);
      }
    }
  } else {
    throw new UsageError(`unknown CLI: ${cli}（claude / codex / agy）`);
  }
  return 0;
}

function one(rest: string[], form: string): string {
  if (rest.length !== 1 || rest[0] === undefined) throw new UsageError(form);
  return rest[0];
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function err(s: string): void {
  process.stderr.write(s + "\n");
}

const isEntry = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (e: unknown) => {
      err(`synapse-skills: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
