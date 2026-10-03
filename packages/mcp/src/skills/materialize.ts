/**
 * Write a skill's files to disk so a CLI can run them
 * (`~/.cache/synapse-skills/<name>@<version>/`, docs/design/skills-mcp.md).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillFile } from "./store.js";

/** `$XDG_CACHE_HOME/synapse-skills`, else `~/.cache/synapse-skills`. */
export function defaultCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : path.join(os.homedir(), ".cache");
  return path.join(base, "synapse-skills");
}

const MANIFEST = ".synapse-skill.json";

function digest(files: readonly SkillFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update("\0").update(String(f.mode & 0o777)).update("\0");
    h.update(f.content).update("\0");
  }
  return h.digest("hex");
}

function readManifestDigest(dir: string): string | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as { digest?: unknown };
    return typeof m.digest === "string" ? m.digest : undefined;
  } catch {
    return undefined;
  }
}

export interface MaterializedSkill {
  /** Absolute directory, or `undefined` when the skill has no files. */
  readonly dir: string | undefined;
  /** Absolute paths of the written files. */
  readonly files: string[];
}

/**
 * Make `<cacheRoot>/<name>@<version>/` hold exactly `files`, with their
 * permission bits.
 *
 * Versions are immutable, so an existing directory is reused as is — unless
 * its manifest says it holds different bytes, which happens only when two
 * stores (a test store and the real one) both have a `name@version`. Then the
 * directory is replaced, because the caller asked for this store's bytes.
 *
 * Written into a temp directory and renamed into place, so a concurrent
 * session never runs a half-written script.
 */
export function materializeSkill(
  cacheRoot: string,
  name: string,
  version: number,
  files: readonly SkillFile[],
): MaterializedSkill {
  if (files.length === 0) return { dir: undefined, files: [] };
  const dir = path.join(cacheRoot, `${name}@${version}`);
  const want = digest(files);
  const paths = files.map((f) => path.join(dir, f.path));
  if (readManifestDigest(dir) === want) return { dir, files: paths };

  fs.mkdirSync(cacheRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(cacheRoot, `.${name}@${version}-`));
  try {
    fs.chmodSync(tmp, 0o755);
    for (const f of files) {
      const p = path.join(tmp, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
      fs.chmodSync(p, f.mode & 0o777);
    }
    fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify({ name, version, digest: want }) + "\n");

    if (fs.existsSync(dir)) {
      // Another session may have just written the same bytes — fine, keep it.
      if (readManifestDigest(dir) === want) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return { dir, files: paths };
      }
      const old = `${tmp}.old`;
      fs.renameSync(dir, old);
      fs.rmSync(old, { recursive: true, force: true });
    }
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      // Lost a race with another session writing the same version.
      if (readManifestDigest(dir) !== want) throw e;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { dir, files: paths };
}
