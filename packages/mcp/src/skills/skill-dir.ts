/**
 * Skill directories on disk (`<name>/SKILL.md` + attached files) ⇄ the store.
 * Used by the management CLI to bring existing skills in and to take them out.
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, withFrontmatter } from "@synapse-chat/core/briefing";
import type { PutSkillInput, SkillFile, SkillRecord } from "./store.js";

/** Never carried into the store: build litter and VCS metadata. */
const IGNORED_NAMES = new Set([".git", "__pycache__", "node_modules", ".DS_Store", ".synapse-skill.json"]);
const IGNORED_SUFFIXES = [".pyc", ".bak"];

function ignored(name: string): boolean {
  return IGNORED_NAMES.has(name) || IGNORED_SUFFIXES.some((s) => name.endsWith(s));
}

export interface ReadSkillDirResult {
  readonly input: PutSkillInput & { readonly files: SkillFile[] };
  /** Things left out (symlinks, ignored litter), for the CLI to report. */
  readonly skipped: string[];
}

/**
 * Read one skill directory. The name comes from the frontmatter `name:`, else
 * the directory name; `description:` is required.
 */
export function readSkillDir(dir: string): ReadSkillDirResult {
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) throw new Error(`${dir}: SKILL.md が無い`);
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(skillMd, "utf8"));
  if (!frontmatter) throw new Error(`${skillMd}: frontmatter が読めない（YAML の構文エラーか、--- の閉じ忘れ）`);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() !== ""
    ? frontmatter.name.trim()
    : path.basename(dir);
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (description === "") throw new Error(`${skillMd}: description が無い`);
  const { name: _n, description: _d, ...rest } = frontmatter;

  const files: SkillFile[] = [];
  const skipped: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel === "" ? ent.name : `${rel}/${ent.name}`;
      const absPath = path.join(abs, ent.name);
      if (relPath === "SKILL.md") continue;
      if (ignored(ent.name)) {
        skipped.push(relPath);
        continue;
      }
      if (ent.isSymbolicLink()) {
        skipped.push(`${relPath}（シンボリックリンク）`);
      } else if (ent.isDirectory()) {
        walk(absPath, relPath);
      } else if (ent.isFile()) {
        files.push({ path: relPath, mode: fs.statSync(absPath).mode & 0o777, content: fs.readFileSync(absPath) });
      }
    }
  };
  walk(dir, "");

  return { input: { name, description, body: body.trim(), frontmatter: rest, files }, skipped };
}

/**
 * The skill directories under `root`: `root` itself if it holds a SKILL.md,
 * otherwise each child that does (`.claude/skills/` → every skill in it).
 */
export function findSkillDirs(root: string): string[] {
  if (fs.existsSync(path.join(root, "SKILL.md"))) return [root];
  if (!fs.existsSync(root)) throw new Error(`${root}: 存在しない`);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !ignored(e.name) && fs.existsSync(path.join(root, e.name, "SKILL.md")))
    .map((e) => path.join(root, e.name))
    .sort();
}

/** The SKILL.md text for a stored version. */
export function renderSkillMd(record: Pick<SkillRecord, "name" | "description" | "body" | "frontmatter">): string {
  return withFrontmatter({ name: record.name, description: record.description, ...record.frontmatter }, record.body);
}

/**
 * Write a stored version out as `<dir>/SKILL.md` + files. Refuses to write into
 * an existing directory unless `force` — that directory may be somebody's only
 * copy of a skill.
 */
export function writeSkillDir(
  dir: string,
  record: Pick<SkillRecord, "name" | "description" | "body" | "frontmatter">,
  files: readonly SkillFile[],
  opts: { force?: boolean } = {},
): void {
  if (fs.existsSync(dir) && !opts.force) {
    throw new Error(`${dir} は既にある（上書きするなら --force）`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), renderSkillMd(record));
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    fs.chmodSync(p, f.mode & 0o777);
  }
}
