/**
 * How each CLI is given the instructions at launch, and how it is kept from
 * also reading the instruction files they replace (docs/design/instructions.md).
 *
 * Pure apart from `realpath`: returns argv, a system prompt to append and
 * `path → content`; the caller decides where to put them. Nothing here writes
 * a file or touches user-wide config (`~/.claude`, `~/.codex`, `~/.gemini`).
 *
 * Unlike skills, instructions are always in context — every CLI gets the full
 * text at start, not a tool to fetch it with.
 */
import fs from "node:fs";
import path from "node:path";

export const INSTRUCTION_CLIS = ["claude", "codex", "agy"] as const;
export type InstructionCli = (typeof INSTRUCTION_CLIS)[number];

export function isInstructionCli(value: string): value is InstructionCli {
  return (INSTRUCTION_CLIS as readonly string[]).includes(value);
}

export interface InstructionsLaunchOptions {
  /** The rendered instructions (`renderInstructions` / `effectiveInstructions`). */
  readonly text: string;
  /** The session's working directory (absolute). */
  readonly cwd: string;
  /**
   * Absolute directories whose instruction files this text replaces. The CLI
   * is told not to read them where it can be; what it will read anyway is
   * returned in {@link InstructionsLaunch.stillLoaded}.
   */
  readonly replaces?: readonly string[];
}

export interface InstructionsLaunch {
  readonly cli: InstructionCli;
  /** Append to the session's system prompt (Claude: `--append-system-prompt`). `""` for the others. */
  readonly systemPromptAppend: string;
  /** Extra arguments for the CLI's command line. */
  readonly args: string[];
  /** Files to write under `cwd` before the CLI starts, `relative path → content`. */
  readonly files: Record<string, string>;
  /**
   * Files the CLI reads at start that could not be switched off, as absolute
   * candidate paths (they may not exist). Check them and warn: if one exists,
   * the session reads the same instructions twice.
   */
  readonly stillLoaded: string[];
}

/** TOML basic strings accept every escape JSON.stringify emits. */
const tomlString = (s: string): string => JSON.stringify(s);

/** picomatch treats these as syntax; a path that contains one must not be read as a glob. */
const escapeGlob = (p: string): string => p.replace(/[\\*?[\]{}()!+@|]/g, "\\$&");

function withRealpaths(dirs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) throw new Error(`replaced directory must be absolute: ${dir}`);
    const resolved = path.resolve(dir);
    out.add(resolved);
    try {
      out.add(fs.realpathSync(resolved));
    } catch {
      // absent: the given path is all there is
    }
  }
  return [...out];
}

/**
 * Claude Code reads, from the cwd up to `/`, `CLAUDE.md`, `CLAUDE.local.md`,
 * `.claude/CLAUDE.md` and `.claude/rules/*.md` — and `AGENTS.md` in a directory
 * whose `CLAUDE.md` it skipped (measured on 2.1.287). The `claudeMdExcludes`
 * setting matches absolute paths, so both the given and the real path go in
 * (`/tmp` is `/private/tmp` on macOS).
 */
const CLAUDE_INSTRUCTION_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/rules/**"];

/** `claudeMdExcludes` patterns for the replaced directories. */
export function claudeInstructionExcludes(replaces: readonly string[]): string[] {
  return withRealpaths(replaces).flatMap((dir) =>
    CLAUDE_INSTRUCTION_FILES.map((f) => `${escapeGlob(dir)}/${f}`),
  );
}

/** agy caps each rule file at 24,000 bytes; leave room for the frontmatter. */
export const AGY_RULE_BYTES = 23_000;
/**
 * A fixed number of rule files, so a shorter text never leaves a stale file
 * behind: the slots it does not need are written empty and `trigger: manual`.
 */
export const AGY_RULE_SLOTS = 8;
export const AGY_INSTRUCTIONS_PLUGIN = "synapse-instructions";

const utf8Length = (s: string): number => Buffer.byteLength(s, "utf8");

/** Split at headings where possible, else at line ends, else inside a line. */
export function chunkInstructions(text: string, limit = AGY_RULE_BYTES): string[] {
  if (text === "") return [];
  const blocks: string[] = [];
  for (const block of text.split(/\n(?=#{1,2} )/)) {
    if (utf8Length(block) <= limit) {
      blocks.push(block);
      continue;
    }
    let cur = "";
    for (const line of block.split("\n")) {
      const next = cur === "" ? line : `${cur}\n${line}`;
      if (utf8Length(next) <= limit) {
        cur = next;
        continue;
      }
      if (cur !== "") blocks.push(cur);
      cur = line;
      while (utf8Length(cur) > limit) {
        let cut = cur.length;
        while (utf8Length(cur.slice(0, cut)) > limit) cut = Math.floor(cut * 0.9);
        blocks.push(cur.slice(0, cut));
        cur = cur.slice(cut);
      }
    }
    if (cur !== "") blocks.push(cur);
  }
  const chunks: string[] = [];
  let cur = "";
  for (const block of blocks) {
    const next = cur === "" ? block : `${cur}\n${block}`;
    if (utf8Length(next) <= limit) cur = next;
    else {
      chunks.push(cur);
      cur = block;
    }
  }
  if (cur !== "") chunks.push(cur);
  return chunks;
}

const agyRule = (body: string | undefined): string =>
  body === undefined ? "---\ntrigger: manual\n---\n" : `---\ntrigger: always_on\n---\n\n${body.replace(/\n+$/, "")}\n`;

/**
 * agy: a workspace plugin whose `rules/` hold the text as always-on rules.
 * agy has no flag for standing instructions; a plugin is the one place under
 * the workspace that is neither the agent's own `AGENTS.md` nor `~/.gemini`.
 * Pass `""` for the withdrawn form (every slot empty).
 */
export function agyInstructionsPluginFiles(text: string): Record<string, string> {
  const chunks = chunkInstructions(text);
  if (chunks.length > AGY_RULE_SLOTS) {
    throw new Error(
      `instructions are too long for agy: ${chunks.length} rule files of ${AGY_RULE_BYTES} bytes, at most ${AGY_RULE_SLOTS}`,
    );
  }
  const dir = `.agents/plugins/${AGY_INSTRUCTIONS_PLUGIN}`;
  const files: Record<string, string> = {
    [`${dir}/plugin.json`]: JSON.stringify({ name: AGY_INSTRUCTIONS_PLUGIN }, null, 2) + "\n",
  };
  for (let i = 0; i < AGY_RULE_SLOTS; i++) {
    files[`${dir}/rules/instructions-${String(i + 1).padStart(2, "0")}.md`] = agyRule(chunks[i]);
  }
  return files;
}

/**
 * The launch inputs for `cli`. Empty `text` changes nothing: no instructions
 * are added and no file is switched off (switching the files off with nothing
 * in their place would launch the agent without any instructions).
 */
export function instructionsLaunch(cli: InstructionCli, options: InstructionsLaunchOptions): InstructionsLaunch {
  if (!path.isAbsolute(options.cwd)) throw new Error(`cwd must be absolute: ${options.cwd}`);
  const empty: InstructionsLaunch = { cli, systemPromptAppend: "", args: [], files: {}, stillLoaded: [] };
  const text = options.text;
  if (text.trim() === "") return empty;
  const replaces = options.replaces ?? [];

  switch (cli) {
    case "claude":
      return {
        ...empty,
        systemPromptAppend: text,
        args: replaces.length > 0
          ? ["--settings", JSON.stringify({ claudeMdExcludes: claudeInstructionExcludes(replaces) })]
          : [],
      };

    case "codex": {
      // Codex reads AGENTS.md from the git root down to the cwd and can only
      // switch them off all together (`project_doc_max_bytes = 0`). Do that
      // only when the cwd itself is replaced; a replaced directory above it
      // that stays readable is reported.
      const cwd = path.resolve(options.cwd);
      const offAll = withRealpaths(replaces).some((d) => withRealpaths([cwd]).includes(d));
      return {
        ...empty,
        args: [
          "-c",
          `developer_instructions=${tomlString(text)}`,
          ...(offAll ? ["-c", "project_doc_max_bytes=0"] : []),
        ],
        stillLoaded: offAll
          ? []
          : replaces.flatMap((d) => [path.join(d, "AGENTS.override.md"), path.join(d, "AGENTS.md")]),
      };
    }

    case "agy":
      // agy has no switch for the directory rules (AGENTS.md / GEMINI.md from
      // the cwd up to the repository root).
      return {
        ...empty,
        files: agyInstructionsPluginFiles(text),
        stillLoaded: replaces.flatMap((d) => [path.join(d, "AGENTS.md"), path.join(d, "GEMINI.md")]),
      };
  }
}

/**
 * The files that take back an earlier delivery, `relative path → content`.
 * Write each only where it already exists (a session that never had DB
 * instructions has nothing to take back). Only agy leaves anything on disk.
 */
export function withdrawInstructionsFiles(cli: InstructionCli): Record<string, string> {
  return cli === "agy" ? agyInstructionsPluginFiles("") : {};
}
