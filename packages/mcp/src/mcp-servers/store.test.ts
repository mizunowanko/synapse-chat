import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstructionStore, GLOBAL_INSTRUCTIONS } from "../instructions/store.js";
import { GLOBAL_SCOPE, agentScope, deskScope } from "../skills/scope.js";
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
