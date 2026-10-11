/**
 * The instruction store (docs/design/instructions.md).
 *
 * An agent's standing instructions — what used to be `CLAUDE.md` /
 * `AGENTS.md` — kept in the same SQLite file as the skills, in their own
 * table. Two tiers: everyone, and one agent. There is no desk tier.
 *
 * Versioning follows the skill store: every write is a new row, versions are
 * never rewritten, and removing a tier's instructions is a tombstone row.
 * Version numbers count per tier (each tier is one document).
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqlite } from "../sqlite.js";
import { agentScope } from "../skills/scope.js";

/** `agent: ""` is the everyone tier. */
export interface InstructionScope {
  readonly agent: string;
}

export type InstructionTier = "global" | "agent";

export const GLOBAL_INSTRUCTIONS: InstructionScope = { agent: "" };

/** The agent tier of `agent`. Throws on a name that is not one safe identifier. */
export function agentInstructions(agent: string): InstructionScope {
  return { agent: agentScope(agent).agent };
}

export function instructionTierOf(scope: InstructionScope): InstructionTier {
  return scope.agent === "" ? "global" : "agent";
}

export function describeInstructionScope(scope: InstructionScope): string {
  return scope.agent === "" ? "全員" : `エージェント ${scope.agent}`;
}

export interface InstructionRecord {
  readonly id: number;
  readonly scope: InstructionScope;
  readonly version: number;
  /** Markdown. Empty on a tombstone. */
  readonly body: string;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly author: string;
}

export interface PutInstructionsResult {
  readonly record: InstructionRecord;
  /** `false` when the body matched the tier's latest live version and nothing was written. */
  readonly changed: boolean;
}

/**
 * Kept apart from the skill store's `schema_version`: an older build that only
 * knows skills opens the same file, sees its own key unchanged, and ignores
 * this table.
 */
const SCHEMA_KEY = "instructions_schema_version";
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS instruction_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL DEFAULT '',
  version     INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  author      TEXT    NOT NULL DEFAULT '',
  UNIQUE (agent, version)
);
`;

interface Row {
  id: number;
  agent: string;
  version: number;
  body: string;
  deleted: number;
  created_at: string;
  author: string;
}

function toRecord(row: Row): InstructionRecord {
  return {
    id: row.id,
    scope: { agent: row.agent },
    version: row.version,
    body: row.body,
    deleted: row.deleted !== 0,
    createdAt: row.created_at,
    author: row.author,
  };
}

/** One trailing newline, `\n` line ends: the same text compares equal however it was saved. */
export function normalizeInstructions(body: string): string {
  const text = body.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return text === "" ? "" : `${text}\n`;
}

export class InstructionStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (creating if needed) the store at `file` — normally the skills DB. */
  static open(file: string): InstructionStore {
    if (!path.isAbsolute(file)) throw new Error(`instruction store path must be absolute: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new (loadSqlite().DatabaseSync)(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_KEY) as { value: string } | undefined;
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(SCHEMA_KEY, String(SCHEMA_VERSION));
    } else if (Number(row.value) > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `instruction store ${file} has schema version ${row.value}; this build understands up to ${SCHEMA_VERSION}`,
      );
    }
    return new InstructionStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** The latest row (live or tombstone) of this tier. */
  latest(scope: InstructionScope): InstructionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM instruction_versions WHERE agent = ? ORDER BY version DESC LIMIT 1")
      .get(scope.agent) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** The tier's live instructions, or `undefined` when it has none (never written, or removed). */
  get(scope: InstructionScope): InstructionRecord | undefined {
    const latest = this.latest(scope);
    return latest && !latest.deleted ? latest : undefined;
  }

  /** Every tier that has live instructions: everyone first, then agents by name. */
  list(): InstructionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM instruction_versions v
         JOIN (SELECT agent, MAX(version) AS version FROM instruction_versions GROUP BY agent) m
           ON v.agent = m.agent AND v.version = m.version
         WHERE v.deleted = 0 ORDER BY v.agent`,
      )
      .all() as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Every version of this tier, oldest first. */
  history(scope: InstructionScope): InstructionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM instruction_versions WHERE agent = ? ORDER BY version")
      .all(scope.agent) as unknown as Row[];
    return rows.map(toRecord);
  }

  /**
   * Write a new version of this tier. Who may write which tier is the
   * caller's rule (only the management CLI writes at all, in this version).
   */
  put(scope: InstructionScope, body: string, author = ""): PutInstructionsResult {
    const text = normalizeInstructions(body);
    if (text === "") throw new Error(`${describeInstructionScope(scope)}: 空の指示書は書けない（消すなら remove）`);
    return this.transaction(() => {
      const latest = this.latest(scope);
      if (latest && !latest.deleted && latest.body === text) return { record: latest, changed: false };
      return { record: this.insert(scope, text, false, author), changed: true };
    });
  }

  /** Tombstone this tier. Earlier versions stay. `undefined` when there was nothing live. */
  remove(scope: InstructionScope, author = ""): InstructionRecord | undefined {
    return this.transaction(() => {
      const latest = this.latest(scope);
      if (!latest || latest.deleted) return undefined;
      return this.insert(scope, "", true, author);
    });
  }

  private insert(scope: InstructionScope, body: string, deleted: boolean, author: string): InstructionRecord {
    const max = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM instruction_versions WHERE agent = ?")
      .get(scope.agent) as { v: number };
    const row = this.db
      .prepare(
        `INSERT INTO instruction_versions (agent, version, body, deleted, created_at, author)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(scope.agent, max.v + 1, body, deleted ? 1 : 0, new Date().toISOString(), author) as unknown as Row;
    return toRecord(row);
  }

  private transaction<T>(fn: () => T): T {
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
