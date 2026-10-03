import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_SCOPE, agentScope, deskScope } from "./scope.js";
import { SkillStore, type SkillFile } from "./store.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const script = (s: string, mode = 0o755): SkillFile => ({ path: "scripts/run.sh", mode, content: enc(s) });

let dir: string;
let store: SkillStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-store-"));
  store = SkillStore.open(path.join(dir, "nested", "skills.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tiers: everyone → agent → desk", () => {
  beforeEach(() => {
    store.put(GLOBAL_SCOPE, { name: "issue", description: "shared issue", body: "global body" });
    store.put(GLOBAL_SCOPE, { name: "proof", description: "shared proof", body: "global proof" });
  });

  it("an agent sees the everyone tier until it writes its own", () => {
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("global body");
    store.put(agentScope("A"), { name: "issue", description: "A's issue", body: "A body" });
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("A body");
  });

  it("the override is the agent's alone", () => {
    store.put(agentScope("A"), { name: "issue", description: "A's issue", body: "A body" });
    expect(store.resolve(agentScope("B"), "issue")?.body).toBe("global body");
    expect(store.resolve(GLOBAL_SCOPE, "issue")?.body).toBe("global body");
  });

  it("a desk beats its agent, and another desk of the same agent does not see it", () => {
    store.put(agentScope("A"), { name: "issue", description: "A", body: "A body" });
    store.put(deskScope("A", "d1"), { name: "issue", description: "d1", body: "d1 body" });
    expect(store.resolve(deskScope("A", "d1"), "issue")?.body).toBe("d1 body");
    expect(store.resolve(deskScope("A", "d2"), "issue")?.body).toBe("A body");
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("A body");
  });

  it("list() shows each name once, from the lowest tier", () => {
    store.put(agentScope("A"), { name: "issue", description: "A's issue", body: "A body" });
    store.put(agentScope("A"), { name: "mine", description: "only A", body: "x" });
    const seen = store.list(agentScope("A")).map((s) => [s.name, s.scope.agent]);
    expect(seen).toEqual([
      ["issue", "A"],
      ["mine", "A"],
      ["proof", ""],
    ]);
    expect(store.list(agentScope("B")).map((s) => s.name)).toEqual(["issue", "proof"]);
  });

  it("deleting an override brings the everyone tier back", () => {
    store.put(agentScope("A"), { name: "issue", description: "A's issue", body: "A body" });
    expect(store.remove(agentScope("A"), "issue")?.deleted).toBe(true);
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("global body");
    expect(store.list(agentScope("A")).find((s) => s.name === "issue")?.scope).toEqual(GLOBAL_SCOPE);
  });

  it("deleting in the everyone tier hides it from everyone without an override", () => {
    store.put(agentScope("A"), { name: "issue", description: "A's issue", body: "A body" });
    store.remove(GLOBAL_SCOPE, "issue");
    expect(store.resolve(agentScope("B"), "issue")).toBeUndefined();
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("A body");
  });

  it("remove() of a tier that does not hold the name is a no-op", () => {
    expect(store.remove(agentScope("A"), "issue")).toBeUndefined();
    expect(store.history("issue")).toHaveLength(1);
  });
});

describe("versions", () => {
  it("every write is a new version, and old versions stay", () => {
    const v1 = store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "one" }).record;
    const v2 = store.put(GLOBAL_SCOPE, { name: "s", body: "two" }).record;
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(store.history("s").map((r) => r.body)).toEqual(["one", "two"]);
  });

  it("numbers versions per name across tiers, so name@version is one row", () => {
    store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "g" });
    const a = store.put(agentScope("A"), { name: "s", body: "a" }).record;
    const g2 = store.put(GLOBAL_SCOPE, { name: "s", body: "g2" }).record;
    expect(a.version).toBe(2);
    expect(g2.version).toBe(3);
  });

  it("writing the same content again does not make a version", () => {
    store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b", files: [script("echo 1")] });
    const again = store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b", files: [script("echo 1")] });
    expect(again.changed).toBe(false);
    expect(store.history("s")).toHaveLength(1);
    expect(store.put(GLOBAL_SCOPE, { name: "s", body: "b", files: [script("echo 1", 0o644)] }).changed).toBe(true);
  });

  it("a deletion is a tombstone version; writing again revives the name", () => {
    store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b" });
    store.remove(GLOBAL_SCOPE, "s");
    expect(store.resolve(GLOBAL_SCOPE, "s")).toBeUndefined();
    const back = store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b" });
    expect(back.changed).toBe(true);
    expect(back.record.version).toBe(3);
    expect(store.history("s").map((r) => r.deleted)).toEqual([false, true, false]);
  });

  it("survives reopening the file", () => {
    store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b", files: [script("echo 1")] });
    store.close();
    store = SkillStore.open(path.join(dir, "nested", "skills.db"));
    const rec = store.resolve(GLOBAL_SCOPE, "s");
    expect(rec?.body).toBe("b");
    expect(dec(store.files(rec!)[0]!.content)).toBe("echo 1");
  });
});

describe("put() carries over what it is not given", () => {
  it("keeps files and description of the skill the tier sees", () => {
    store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b", files: [script("echo g")], frontmatter: { "argument-hint": "[x]" } });
    const a = store.put(agentScope("A"), { name: "s", body: "A's prose" }).record;
    expect(a.description).toBe("d");
    expect(a.frontmatter).toEqual({ "argument-hint": "[x]" });
    expect(store.files(a).map((f) => [f.path, f.mode, dec(f.content)])).toEqual([["scripts/run.sh", 0o755, "echo g"]]);
  });

  it("files: [] drops them", () => {
    store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b", files: [script("echo g")] });
    const v2 = store.put(GLOBAL_SCOPE, { name: "s", body: "b", files: [] }).record;
    expect(store.files(v2)).toEqual([]);
  });

  it("a new skill needs a description", () => {
    expect(() => store.put(GLOBAL_SCOPE, { name: "s", body: "b" })).toThrow(/description/);
  });

  it("never stores name/description inside frontmatter", () => {
    const r = store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b", frontmatter: { name: "x", description: "y", k: 1 } }).record;
    expect(r.frontmatter).toEqual({ k: 1 });
  });
});

describe("validation", () => {
  it.each(["../x", "a b", "", "-x", "a/b", "x".repeat(65)])("rejects skill name %j", (name) => {
    expect(() => store.put(GLOBAL_SCOPE, { name, description: "d", body: "b" })).toThrow(/skill name/);
  });

  it.each(["../evil.sh", "/etc/passwd", "a/../../b", "./x", "SKILL.md", "a//b", "a\\b"])("rejects file path %j", (p) => {
    expect(() =>
      store.put(GLOBAL_SCOPE, { name: "s", description: "d", body: "b", files: [{ path: p, mode: 0o644, content: enc("x") }] }),
    ).toThrow(/file path/);
  });

  it("refuses a relative store path", () => {
    expect(() => SkillStore.open("skills.db")).toThrow(/absolute/);
  });
});
