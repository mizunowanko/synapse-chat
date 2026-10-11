import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_SCOPE } from "../skills/scope.js";
import { SkillStore } from "../skills/store.js";
import { effectiveInstructions, readInstructionFile, renderInstructions } from "./render.js";
import { GLOBAL_INSTRUCTIONS, InstructionStore, agentInstructions } from "./store.js";

let dir: string;
let file: string;
let store: InstructionStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-store-"));
  file = path.join(dir, "nested", "skills.db");
  store = InstructionStore.open(file);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("InstructionStore", () => {
  it("keeps every version and counts versions per tier", () => {
    expect(store.put(GLOBAL_INSTRUCTIONS, "# 全員\nv1").record.version).toBe(1);
    expect(store.put(agentInstructions("A"), "# A\nv1").record.version).toBe(1);
    expect(store.put(GLOBAL_INSTRUCTIONS, "# 全員\nv2").record.version).toBe(2);
    expect(store.get(GLOBAL_INSTRUCTIONS)?.body).toBe("# 全員\nv2\n");
    expect(store.history(GLOBAL_INSTRUCTIONS).map((r) => r.body)).toEqual(["# 全員\nv1\n", "# 全員\nv2\n"]);
  });

  it("does not add a version when the text is the same (line ends and trailing newlines aside)", () => {
    store.put(GLOBAL_INSTRUCTIONS, "a\nb\n");
    const again = store.put(GLOBAL_INSTRUCTIONS, "a\r\nb\n\n\n");
    expect(again.changed).toBe(false);
    expect(store.history(GLOBAL_INSTRUCTIONS)).toHaveLength(1);
  });

  it("removes with a tombstone; earlier versions stay and a write revives the tier", () => {
    store.put(agentInstructions("A"), "one");
    const tomb = store.remove(agentInstructions("A"));
    expect(tomb?.version).toBe(2);
    expect(store.get(agentInstructions("A"))).toBeUndefined();
    expect(store.remove(agentInstructions("A"))).toBeUndefined();
    expect(store.put(agentInstructions("A"), "one").record.version).toBe(3);
    expect(store.history(agentInstructions("A")).map((r) => r.deleted)).toEqual([false, true, false]);
  });

  it("lists live tiers, everyone first", () => {
    store.put(agentInstructions("B"), "b");
    store.put(GLOBAL_INSTRUCTIONS, "g");
    store.put(agentInstructions("A"), "a");
    store.remove(agentInstructions("B"));
    expect(store.list().map((r) => r.scope.agent)).toEqual(["", "A"]);
  });

  it("refuses an empty text and a bad agent name", () => {
    expect(() => store.put(GLOBAL_INSTRUCTIONS, "\n\n")).toThrow(/空/);
    expect(() => agentInstructions("a/b")).toThrow();
  });

  it("shares the file with the skill store without touching its schema", () => {
    const skills = SkillStore.open(file);
    skills.put(GLOBAL_SCOPE, { name: "x", description: "d", body: "b" });
    store.put(GLOBAL_INSTRUCTIONS, "g");
    expect(skills.list(GLOBAL_SCOPE).map((s) => s.name)).toEqual(["x"]);
    skills.close();
  });
});

describe("effective instructions", () => {
  it("puts the agent after everyone and the skills paragraph first", () => {
    store.put(GLOBAL_INSTRUCTIONS, "# 共通\n全員へ");
    store.put(agentInstructions("A"), "# A\nA へ");
    const eff = effectiveInstructions(store, "A");
    expect(eff.globalVersion).toBe(1);
    expect(eff.agentVersion).toBe(1);
    const lines = eff.text.split("\n");
    expect(lines[0]).toBe("## スキル");
    expect(eff.text.indexOf("# 共通")).toBeLessThan(eff.text.indexOf("# A"));
    expect(eff.text.endsWith("A へ\n")).toBe(true);
  });

  it("an agent without its own tier sees only everyone's; nobody sees another agent's", () => {
    store.put(GLOBAL_INSTRUCTIONS, "g");
    store.put(agentInstructions("A"), "only A");
    const b = effectiveInstructions(store, "B");
    expect(b.text).toContain("g");
    expect(b.text).not.toContain("only A");
    expect(b.agentVersion).toBeUndefined();
  });

  it("is empty when there is nothing, without a lone skills paragraph", () => {
    expect(effectiveInstructions(store, "A").text).toBe("");
  });

  it("does not add the skills paragraph twice", () => {
    const text = renderInstructions({ global: "## スキル\n\n独自の文言\n" });
    expect(text.match(/## スキル/g)).toHaveLength(1);
    expect(text).toContain("独自の文言");
    expect(renderInstructions({ global: "x" }, { skillsGuidance: false })).toBe("x\n");
  });

  it("reads an instruction file without the Briefing fingerprint", () => {
    const p = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(p, "# A\r\n本文\n\n<!-- briefing:v1 fingerprint=0123456789abcdef -->\n");
    expect(readInstructionFile(p)).toBe("# A\n本文\n");
  });
});
