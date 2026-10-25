import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstructionStore, GLOBAL_INSTRUCTIONS } from "../instructions/store.js";
import { GLOBAL_SCOPE, agentScope, deskScope, deskViewer } from "../skills/scope.js";
import { SkillStore } from "../skills/store.js";
import { loadSqlite } from "../sqlite.js";
import type { McpServerConfig } from "./config.js";
import { McpServerStore } from "./store.js";

let dir: string;
let file: string;
let store: McpServerStore;

const http = (url: string): McpServerConfig => ({ transport: "http", url });
const stdio = (command: string): McpServerConfig => ({ transport: "stdio", command });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-servers-store-"));
  file = path.join(dir, "nested", "skills.db");
  store = McpServerStore.open(file);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("McpServerStore", () => {
  it("keeps every version; numbers count per name across tiers", () => {
    expect(store.put(GLOBAL_SCOPE, { name: "a", config: http("https://g/1") }).record.version).toBe(1);
    expect(store.put(agentScope("A"), { name: "a", config: http("https://a/1") }).record.version).toBe(2);
    expect(store.put(GLOBAL_SCOPE, { name: "a", config: http("https://g/2") }).record.version).toBe(3);
    expect(store.history("a").map((r) => [r.version, r.scope.agent, (r.config as { url: string }).url])).toEqual([
      [1, "", "https://g/1"],
      [2, "A", "https://a/1"],
      [3, "", "https://g/2"],
    ]);
  });

  it("does not add a version when nothing changed (key order aside)", () => {
    store.put(GLOBAL_SCOPE, { name: "a", config: { transport: "stdio", command: "x", env: { B: "1", A: "2" } } });
    const again = store.put(GLOBAL_SCOPE, {
      name: "a",
      config: { env: { B: "1", A: "2" }, command: "x", transport: "stdio" } as McpServerConfig,
    });
    expect(again.changed).toBe(false);
    expect(store.put(GLOBAL_SCOPE, { name: "a", config: again.record.config, enabled: false }).changed).toBe(true);
    expect(store.history("a")).toHaveLength(2);
  });

  it("the lowest tier wins; desk over agent over everyone", () => {
    store.put(GLOBAL_SCOPE, { name: "a", config: http("https://g") });
    store.put(GLOBAL_SCOPE, { name: "g", config: stdio("g") });
    store.put(agentScope("A"), { name: "a", config: http("https://agent") });
    store.put(deskScope("A", "d1"), { name: "a", config: http("https://desk") });
    store.put(agentScope("B"), { name: "b", config: stdio("b") });

    const url = (r: { config: McpServerConfig } | undefined) => (r?.config as { url?: string } | undefined)?.url;
    expect(url(store.resolve(GLOBAL_SCOPE, "a"))).toBe("https://g");
    expect(url(store.resolve(agentScope("A"), "a"))).toBe("https://agent");
    expect(url(store.resolve(deskScope("A", "d1"), "a"))).toBe("https://desk");
    expect(url(store.resolve(deskScope("A", "d2"), "a"))).toBe("https://agent");
    expect(store.effective(deskScope("A", "d1")).enabled.map((r) => r.name)).toEqual(["a", "g"]);
    expect(store.effective(agentScope("B")).enabled.map((r) => r.name)).toEqual(["a", "b", "g"]);
  });

  it("a lower tier's enabled: false switches the server off for that viewer only", () => {
    store.put(GLOBAL_SCOPE, { name: "a", config: http("https://g") });
    store.put(agentScope("A"), { name: "a", config: http("https://g"), enabled: false });
    expect(store.effective(agentScope("A"))).toMatchObject({ enabled: [], disabled: [{ name: "a" }] });
    expect(store.effective(agentScope("B")).enabled.map((r) => r.name)).toEqual(["a"]);
  });

  it("removes with a tombstone: earlier versions stay, and the upper tier shows again", () => {
    store.put(GLOBAL_SCOPE, { name: "a", config: http("https://g") });
    store.put(agentScope("A"), { name: "a", config: http("https://agent") });
    const tomb = store.remove(agentScope("A"), "a", "test");
    expect(tomb).toMatchObject({ deleted: true, version: 3, author: "test" });
    expect(store.remove(agentScope("A"), "a")).toBeUndefined();
    expect((store.resolve(agentScope("A"), "a")?.config as { url: string }).url).toBe("https://g");
    expect(store.history("a").map((r) => r.deleted)).toEqual([false, false, true]);

    store.put(agentScope("A"), { name: "a", config: http("https://agent2") });
    expect(store.latestIn(agentScope("A"), "a")?.version).toBe(4);
    expect(store.listAll().map((r) => `${r.scope.agent}:${r.name}`)).toEqual([":a", "A:a"]);
  });

  it("validates the name and the config on write", () => {
    expect(() => store.put(GLOBAL_SCOPE, { name: "skills", config: stdio("x") })).toThrow(/reserved/);
    expect(() => store.put(GLOBAL_SCOPE, { name: "a__b", config: stdio("x") })).toThrow(/invalid/);
    expect(() => store.put(GLOBAL_SCOPE, { name: "a", config: { transport: "http", url: "nope" } })).toThrow(/URL/);
    expect(store.history("a")).toEqual([]);
  });

  it("shares the file with the skills and the instructions without touching their schema keys", () => {
    store.close();
    const skills = SkillStore.open(file);
    skills.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b" });
    skills.close();
    const instructions = InstructionStore.open(file);
    instructions.put(GLOBAL_INSTRUCTIONS, "# x");
    instructions.close();
    store = McpServerStore.open(file);
    store.put(GLOBAL_SCOPE, { name: "a", config: stdio("x") });
    store.close();

    const again = SkillStore.open(file);
    expect(again.resolve(GLOBAL_SCOPE, "s")?.body).toBe("b");
    again.close();
    store = McpServerStore.open(file);
    expect(store.listAll()).toHaveLength(1);
  });

  it("a desk keyed on its id reads the rows still keyed on its name beneath it (agt-215)", () => {
    store.put(agentScope("A"), { name: "a", config: http("https://agent") });
    store.put(deskScope("A", "main"), { name: "a", config: http("https://by-name") });
    store.put(deskScope("A", "main"), { name: "b", config: http("https://b-by-name"), enabled: false });
    const before = store.effective(deskViewer("A", "desk-1", "main"));
    expect(before.enabled.map((r) => [r.name, (r.config as { url: string }).url])).toEqual([["a", "https://by-name"]]);
    expect(before.disabled.map((r) => r.name)).toEqual(["b"]);

    store.put(deskScope("A", "desk-1"), { name: "a", config: http("https://by-id") });
    expect(store.resolve(deskViewer("A", "desk-1", "main"), "a")?.config).toEqual(http("https://by-id"));
    // Another desk that takes the old name later sees the name's rows, not the id's.
    expect(store.resolve(deskViewer("A", "desk-2"), "a")?.config).toEqual(http("https://agent"));
  });

  it("keeps the ui mark: a version of its own, listed by listApps, carried by a tombstone", () => {
    store.put(GLOBAL_SCOPE, { name: "app", config: http("https://app"), ui: true });
    store.put(agentScope("A"), { name: "app", config: http("https://app"), ui: true });
    store.put(GLOBAL_SCOPE, { name: "plain", config: http("https://plain") });
    expect(store.put(GLOBAL_SCOPE, { name: "app", config: http("https://app"), ui: true }).changed).toBe(false);
    expect(store.resolve(agentScope("A"), "app")?.ui).toBe(true);
    expect(store.resolve(GLOBAL_SCOPE, "plain")?.ui).toBe(false);
    expect(store.listApps().map((r) => `${r.scope.agent}:${r.name}`)).toEqual([":app", "A:app"]);
    expect(store.effective(agentScope("A")).enabled.map((r) => [r.name, r.ui])).toEqual([["app", true], ["plain", false]]);

    // Taking the mark off is a new version.
    expect(store.put(agentScope("A"), { name: "app", config: http("https://app") }).changed).toBe(true);
    expect(store.listApps().map((r) => `${r.scope.agent}:${r.name}`)).toEqual([":app"]);
    expect(store.remove(GLOBAL_SCOPE, "app")).toMatchObject({ deleted: true, ui: true });
    expect(store.listApps()).toEqual([]);
  });

  it("adds the ui column to a table made before it, and a build without it still writes", () => {
    store.close();
    const { DatabaseSync } = loadSqlite();
    const legacy = path.join(dir, "legacy.db");
    const db = new DatabaseSync(legacy);
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('mcp_servers_schema_version', '1');
      CREATE TABLE mcp_server_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, version INTEGER NOT NULL,
        agent TEXT NOT NULL DEFAULT '', desk TEXT NOT NULL DEFAULT '', config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', UNIQUE (name, version));
      INSERT INTO mcp_server_versions (name, version, config, created_at) VALUES ('old', 1, '{"transport":"http","url":"https://old"}', 'then');`);
    db.close();

    store = McpServerStore.open(legacy);
    expect(store.resolve(GLOBAL_SCOPE, "old")).toMatchObject({ ui: false, enabled: true });
    store.put(GLOBAL_SCOPE, { name: "app", config: http("https://app"), ui: true });
    store.close();

    // What a build without the column does: it names its columns, the new one takes its default.
    const older = new DatabaseSync(legacy);
    expect((older.prepare("SELECT value FROM meta WHERE key = 'mcp_servers_schema_version'").get() as { value: string }).value).toBe("1");
    older.prepare(
      "INSERT INTO mcp_server_versions (name, version, agent, desk, config, enabled, deleted, created_at, author) VALUES ('x', 1, '', '', '{\"transport\":\"http\",\"url\":\"https://x\"}', 1, 0, 'now', '')",
    ).run();
    older.close();
    store = McpServerStore.open(legacy);
    expect(store.listAll().map((r) => [r.name, r.ui])).toEqual([["app", true], ["old", false], ["x", false]]);
  });

  it("refuses a store from a newer build", () => {
    store.close();
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'mcp_servers_schema_version'").run();
    db.close();
    expect(() => McpServerStore.open(file)).toThrow(/schema version 99/);
    store = McpServerStore.open(path.join(dir, "other.db"));
  });
});
