/**
 * The MCP server ledger (docs/design/mcp-servers.md).
 *
 * The MCP servers an agent's sessions get, kept provider-neutral in the same
 * SQLite file as the skills and the instructions, in their own table. Tiers
 * are the skills' (everyone → agent → desk): the lower tier wins when two
 * hold the same name.
 *
 * Versioning follows the skill store: every write is a new row, versions are
 * never rewritten, removing is a tombstone row, and version numbers count per
 * server *name* across all tiers.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqlite } from "../sqlite.js";
import { visibleScopes, type SkillScope, type SkillViewer } from "../skills/scope.js";
import { assertMcpServerName, parseMcpServerConfig, type McpServerConfig } from "./config.js";

/**
 * Same shape as a skill's scope: `agent: ""` is everyone, `desk: ""` is "not a
 * desk". `desk` is the desk tier's key — the desk id (agt-215); older rows hold
 * the desk's name.
 */
export type McpServerScope = SkillScope;

/** Who is looking, with the desk's legacy key (its name) read beneath the id. Same as {@link SkillViewer}. */
export type McpServerViewer = SkillViewer;

export interface McpServerRecord {
  readonly id: number;
  readonly name: string;
  readonly version: number;
  readonly scope: McpServerScope;
  readonly enabled: boolean;
  /** The transport. On a tombstone, the config of the version it removed. */
  readonly config: McpServerConfig;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly author: string;
}

export interface PutMcpServerInput {
  readonly name: string;
  readonly config: McpServerConfig;
  /** Default `true`. */
  readonly enabled?: boolean;
  /** Free-form note of who wrote it (`cli:put`…). */
  readonly author?: string;
}

export interface PutMcpServerResult {
  readonly record: McpServerRecord;
  /** `false` when the input matched the tier's latest live version and nothing was written. */
  readonly changed: boolean;
}

/**
 * Kept apart from the skill store's `schema_version` and the instruction
 * store's key: an older build opens the same file, sees its own key
 * unchanged, and ignores this table.
 */
const SCHEMA_KEY = "mcp_servers_schema_version";
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_server_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  agent       TEXT    NOT NULL DEFAULT '',
  desk        TEXT    NOT NULL DEFAULT '',
  config      TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  author      TEXT    NOT NULL DEFAULT '',
  UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS mcp_server_versions_scope ON mcp_server_versions (agent, desk, name, version);
`;

interface Row {
  id: number;
  name: string;
  version: number;
  agent: string;
  desk: string;
  config: string;
  enabled: number;
  deleted: number;
  created_at: string;
  author: string;
}

function toRecord(row: Row): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    scope: { agent: row.agent, desk: row.desk },
    enabled: row.enabled !== 0,
    config: JSON.parse(row.config) as McpServerConfig,
    deleted: row.deleted !== 0,
    createdAt: row.created_at,
    author: row.author,
  };
}

/** The servers a viewer gets: live, lowest tier first per name; `enabled: false` ones apart. */
export interface EffectiveMcpServers {
  /** On, by name. What a launch hands to the CLI. */
  readonly enabled: McpServerRecord[];
  /** Switched off in the tier that wins, by name. Not handed out; said so in the launch result. */
  readonly disabled: McpServerRecord[];
}

export class McpServerStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (creating if needed) the store at `file` — normally the skills DB. */
  static open(file: string): McpServerStore {
    if (!path.isAbsolute(file)) throw new Error(`MCP server store path must be absolute: ${file}`);
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
        `MCP server store ${file} has schema version ${row.value}; this build understands up to ${SCHEMA_VERSION}`,
      );
    }
    return new McpServerStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** The latest row (live or tombstone) of `name` in exactly this tier. */
  latestIn(scope: McpServerScope, name: string): McpServerRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM mcp_server_versions WHERE agent = ? AND desk = ? AND name = ? ORDER BY version DESC LIMIT 1",
      )
      .get(scope.agent, scope.desk, name) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** The server `viewer` gets under `name`: the lowest tier that holds a live version (enabled or not). */
  resolve(viewer: McpServerViewer, name: string): McpServerRecord | undefined {
    for (const scope of visibleScopes(viewer)) {
      const latest = this.latestIn(scope, name);
      if (latest && !latest.deleted) return latest;
    }
    return undefined;
  }

  /** Every live server in exactly this tier, by name. */
  listIn(scope: McpServerScope): McpServerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM mcp_server_versions v
         JOIN (SELECT name, MAX(version) AS version FROM mcp_server_versions
               WHERE agent = ? AND desk = ? GROUP BY name) m
           ON v.name = m.name AND v.version = m.version
         WHERE v.deleted = 0 ORDER BY v.name`,
      )
      .all(scope.agent, scope.desk) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** Every live server in every tier: everyone first, then agents and desks by name. */
  listAll(): McpServerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM mcp_server_versions v
         JOIN (SELECT agent, desk, name, MAX(version) AS version FROM mcp_server_versions
               GROUP BY agent, desk, name) m
           ON v.agent = m.agent AND v.desk = m.desk AND v.name = m.name AND v.version = m.version
         WHERE v.deleted = 0 ORDER BY v.agent, v.desk, v.name`,
      )
      .all() as unknown as Row[];
    return rows.map(toRecord);
  }

  /**
   * Every server `viewer` sees after the lower tiers have shadowed the upper
   * ones. A lower tier's `enabled: false` switches the upper tier's server off
   * for this viewer; a lower tier's tombstone does not hide the upper tier
   * (removing an override brings the shared server back), as with skills.
   */
  effective(viewer: McpServerViewer): EffectiveMcpServers {
    const seen = new Map<string, McpServerRecord>();
    for (const scope of visibleScopes(viewer)) {
      for (const rec of this.listIn(scope)) if (!seen.has(rec.name)) seen.set(rec.name, rec);
    }
    const all = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { enabled: all.filter((r) => r.enabled), disabled: all.filter((r) => !r.enabled) };
  }

  /** Every version of `name` in every tier, oldest first. */
  history(name: string): McpServerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM mcp_server_versions WHERE name = ? ORDER BY version")
      .all(name) as unknown as Row[];
    return rows.map(toRecord);
  }

  /**
   * Write a new version of `input.name` into `scope`. Who may write which
   * tier is the caller's rule (only the management CLI writes, in this
   * version).
   */
  put(scope: McpServerScope, input: PutMcpServerInput): PutMcpServerResult {
    assertMcpServerName(input.name);
    const config = JSON.stringify(parseMcpServerConfig(input.config));
    const enabled = input.enabled ?? true;
    return this.transaction(() => {
      const latest = this.latestIn(scope, input.name);
      if (latest && !latest.deleted && latest.enabled === enabled && JSON.stringify(latest.config) === config) {
        return { record: latest, changed: false };
      }
      return { record: this.insert(scope, input.name, config, enabled, false, input.author ?? ""), changed: true };
    });
  }

  /** Tombstone `name` in exactly this tier. Earlier versions stay. `undefined` when there was nothing live. */
  remove(scope: McpServerScope, name: string, author = ""): McpServerRecord | undefined {
    return this.transaction(() => {
      const latest = this.latestIn(scope, name);
      if (!latest || latest.deleted) return undefined;
      return this.insert(scope, name, JSON.stringify(latest.config), latest.enabled, true, author);
    });
  }

  private insert(
    scope: McpServerScope,
    name: string,
    config: string,
    enabled: boolean,
    deleted: boolean,
    author: string,
  ): McpServerRecord {
    const max = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM mcp_server_versions WHERE name = ?")
      .get(name) as { v: number };
    const row = this.db
      .prepare(
        `INSERT INTO mcp_server_versions (name, version, agent, desk, config, enabled, deleted, created_at, author)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        name,
        max.v + 1,
        scope.agent,
        scope.desk,
        config,
        enabled ? 1 : 0,
        deleted ? 1 : 0,
        new Date().toISOString(),
        author,
      ) as unknown as Row;
    return toRecord(row);
  }

  private transaction<T>(fn: () => T): T {
    // IMMEDIATE takes the write lock up front, so two writers of the same
    // name cannot both read MAX(version) = n and both insert n + 1.
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
