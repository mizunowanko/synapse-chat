/**
 * The skill store: one SQLite file (docs/design/skills-mcp.md).
 *
 * Every write is a new row — versions are never rewritten, and deleting a
 * skill is a tombstone row. Version numbers are per skill *name* across all
 * tiers, so `<name>@<version>` names exactly one row in a store; that is what
 * makes the materialised directory `~/.cache/synapse-skills/<name>@<version>/`
 * unambiguous.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSkillName,
  visibleScopes,
  type SkillScope,
} from "./scope.js";

/** A file shipped with a skill (a script, a template…). `path` is relative to the skill directory. */
export interface SkillFile {
  readonly path: string;
  /** Permission bits (`0o755` for an executable script). */
  readonly mode: number;
  readonly content: Uint8Array;
}

export interface SkillRecord {
  readonly id: number;
  readonly name: string;
  readonly version: number;
  readonly scope: SkillScope;
  readonly description: string;
  /** The SKILL.md body without its frontmatter. */
  readonly body: string;
  /** Frontmatter keys other than `name` / `description`, kept so an export round-trips. */
  readonly frontmatter: Record<string, unknown>;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly author: string;
}

export interface PutSkillInput {
  readonly name: string;
  /** Omit to keep the description of the skill the target tier currently sees. */
  readonly description?: string;
  readonly body: string;
  /** Omit to keep the frontmatter of the skill the target tier currently sees. */
  readonly frontmatter?: Record<string, unknown>;
  /**
   * Omit to carry over the files of the skill the target tier currently sees
   * (so editing the prose does not drop the script). Pass `[]` to drop them.
   */
  readonly files?: readonly SkillFile[];
  /** Free-form note of who wrote it (`cli`, `mcp:Tsukuyo`…). */
  readonly author?: string;
}

export interface PutSkillResult {
  readonly record: SkillRecord;
  /** `false` when the input matched the tier's latest version and nothing was written. */
  readonly changed: boolean;
}

/**
 * `node:sqlite` is loaded at run time rather than imported: it exists only as
 * `node:sqlite` (no bare `sqlite` alias), and bundlers / vite-node that strip
 * the `node:` prefix fail to resolve a static import of it. This also gives a
 * readable error on a Node without it.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const mod = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite");
  if (!mod) {
    throw new Error(`the skill store needs node:sqlite (Node 22.13 or later); this is Node ${process.versions.node}`);
  }
  return mod as typeof import("node:sqlite");
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  agent       TEXT    NOT NULL DEFAULT '',
  desk        TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  frontmatter TEXT    NOT NULL DEFAULT '{}',
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  author      TEXT    NOT NULL DEFAULT '',
  UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS skill_versions_scope ON skill_versions (agent, desk, name, version);
CREATE TABLE IF NOT EXISTS skill_files (
  version_id INTEGER NOT NULL REFERENCES skill_versions (id),
  path       TEXT    NOT NULL,
  mode       INTEGER NOT NULL,
  content    BLOB    NOT NULL,
  PRIMARY KEY (version_id, path)
);
`;

interface Row {
  id: number;
  name: string;
  version: number;
  agent: string;
  desk: string;
  description: string;
  body: string;
  frontmatter: string;
  deleted: number;
  created_at: string;
  author: string;
}

function toRecord(row: Row): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    scope: { agent: row.agent, desk: row.desk },
    description: row.description,
    body: row.body,
    frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
    deleted: row.deleted !== 0,
    createdAt: row.created_at,
    author: row.author,
  };
}

/** A relative, normalised path inside the skill directory. Throws otherwise. */
export function assertSkillFilePath(p: string): void {
  const norm = path.posix.normalize(p);
  if (
    p === "" ||
    p !== norm ||
    path.posix.isAbsolute(p) ||
    p.includes("\\") ||
    norm.split("/").some((seg) => seg === ".." || seg === "." || seg === "") ||
    norm === "SKILL.md"
  ) {
    throw new Error(`invalid skill file path: ${JSON.stringify(p)}`);
  }
}

function filesEqual(a: readonly SkillFile[], b: readonly SkillFile[]): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(b.map((f) => [f.path, f]));
  return a.every((f) => {
    const other = byPath.get(f.path);
    return (
      other !== undefined &&
      (other.mode & 0o777) === (f.mode & 0o777) &&
      Buffer.from(other.content).equals(Buffer.from(f.content))
    );
  });
}

function stripIdentityKeys(fm: Record<string, unknown>): Record<string, unknown> {
  const { name: _n, description: _d, ...rest } = fm;
  return rest;
}

export class SkillStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (creating if needed) the store at `file`. The parent directory is created. */
  static open(file: string): SkillStore {
    if (!path.isAbsolute(file)) throw new Error(`skill store path must be absolute: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new (loadSqlite().DatabaseSync)(file);
    // One CLI session per server process, many at once: let readers and the
    // occasional writer overlap instead of failing with SQLITE_BUSY.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(row.value) > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `skill store ${file} has schema version ${row.value}; this build understands up to ${SCHEMA_VERSION}`,
      );
    }
    return new SkillStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** The latest row (live or tombstone) of `name` in exactly this tier. */
  latestIn(scope: SkillScope, name: string): SkillRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM skill_versions WHERE agent = ? AND desk = ? AND name = ? ORDER BY version DESC LIMIT 1",
      )
      .get(scope.agent, scope.desk, name) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** The skill `viewer` sees under `name`: the lowest tier that holds a live version. */
  resolve(viewer: SkillScope, name: string): SkillRecord | undefined {
    for (const scope of visibleScopes(viewer)) {
      const latest = this.latestIn(scope, name);
      if (latest && !latest.deleted) return latest;
    }
    return undefined;
  }

  /** Every live skill in exactly this tier, by name. */
  listIn(scope: SkillScope): SkillRecord[] {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM skill_versions v
         JOIN (SELECT name, MAX(version) AS version FROM skill_versions
               WHERE agent = ? AND desk = ? GROUP BY name) m
           ON v.name = m.name AND v.version = m.version
         WHERE v.deleted = 0 ORDER BY v.name`,
      )
      .all(scope.agent, scope.desk) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Every skill `viewer` sees, after the lower tiers have shadowed the upper ones. */
  list(viewer: SkillScope): SkillRecord[] {
    const seen = new Map<string, SkillRecord>();
    for (const scope of visibleScopes(viewer)) {
      // A tombstone in a lower tier does not hide the upper tier: deleting an
      // override brings the shared skill back. Only live rows shadow.
      for (const rec of this.listIn(scope)) {
        if (!seen.has(rec.name)) seen.set(rec.name, rec);
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every version of `name` in every tier, oldest first. */
  history(name: string): SkillRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM skill_versions WHERE name = ? ORDER BY version")
      .all(name) as unknown as Row[];
    return rows.map(toRecord);
  }

  files(record: Pick<SkillRecord, "id">): SkillFile[] {
    const rows = this.db
      .prepare("SELECT path, mode, content FROM skill_files WHERE version_id = ? ORDER BY path")
      .all(record.id) as unknown as { path: string; mode: number; content: Uint8Array }[];
    return rows.map((r) => ({ path: r.path, mode: r.mode, content: new Uint8Array(r.content) }));
  }

  /**
   * Write a new version of `input.name` into `scope`. Permission checks are the
   * caller's job (`mcpWriteRefusal`); the store writes wherever it is told.
   */
  put(scope: SkillScope, input: PutSkillInput): PutSkillResult {
    assertSkillName(input.name);
    const files = input.files?.map((f) => {
      assertSkillFilePath(f.path);
      return { path: f.path, mode: f.mode & 0o777, content: f.content };
    });
    if (files && new Set(files.map((f) => f.path)).size !== files.length) {
      throw new Error(`duplicate file path in skill ${input.name}`);
    }

    return this.transaction(() => {
      const seen = this.resolve(scope, input.name);
      const description = (input.description ?? seen?.description ?? "").trim();
      if (description === "") {
        throw new Error(`skill ${input.name}: description is required for a new skill`);
      }
      const frontmatter = stripIdentityKeys(input.frontmatter ?? seen?.frontmatter ?? {});
      const nextFiles = files ?? (seen ? this.files(seen) : []);
      const body = input.body;

      const latest = this.latestIn(scope, input.name);
      if (
        latest &&
        !latest.deleted &&
        latest.description === description &&
        latest.body === body &&
        JSON.stringify(latest.frontmatter) === JSON.stringify(frontmatter) &&
        filesEqual(this.files(latest), nextFiles)
      ) {
        return { record: latest, changed: false };
      }

      const record = this.insertVersion(scope, input.name, {
        description,
        body,
        frontmatter,
        deleted: false,
        author: input.author ?? "",
      });
      const ins = this.db.prepare(
        "INSERT INTO skill_files (version_id, path, mode, content) VALUES (?, ?, ?, ?)",
      );
      for (const f of nextFiles) ins.run(record.id, f.path, f.mode, f.content);
      return { record, changed: true };
    });
  }

  /**
   * Mark `name` deleted in exactly this tier. Earlier versions stay. Returns
   * the tombstone, or `undefined` when the tier had no live version.
   */
  remove(scope: SkillScope, name: string, author = ""): SkillRecord | undefined {
    return this.transaction(() => {
      const latest = this.latestIn(scope, name);
      if (!latest || latest.deleted) return undefined;
      return this.insertVersion(scope, name, {
        description: latest.description,
        body: "",
        frontmatter: {},
        deleted: true,
        author,
      });
    });
  }

  private insertVersion(
    scope: SkillScope,
    name: string,
    v: { description: string; body: string; frontmatter: Record<string, unknown>; deleted: boolean; author: string },
  ): SkillRecord {
    const max = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM skill_versions WHERE name = ?")
      .get(name) as { v: number };
    const row = this.db
      .prepare(
        `INSERT INTO skill_versions (name, version, agent, desk, description, body, frontmatter, deleted, created_at, author)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        name,
        max.v + 1,
        scope.agent,
        scope.desk,
        v.description,
        v.body,
        JSON.stringify(v.frontmatter),
        v.deleted ? 1 : 0,
        new Date().toISOString(),
        v.author,
      ) as unknown as Row;
    return toRecord(row);
  }

  private transaction<T>(fn: () => T): T {
    // IMMEDIATE takes the write lock up front, so two sessions writing the
    // same name cannot both read MAX(version) = n and both insert n + 1.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
