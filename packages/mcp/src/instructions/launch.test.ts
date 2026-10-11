import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGY_RULE_BYTES,
  AGY_RULE_SLOTS,
  agyInstructionsPluginFiles,
  chunkInstructions,
  claudeInstructionExcludes,
  instructionsLaunch,
  withdrawInstructionsFiles,
} from "./launch.js";

let root: string;
let agent: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-launch-"));
  agent = path.join(root, "agents", "A");
  fs.mkdirSync(agent, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const TEXT = "# 共通\n全員へ\n# A\nA へ\n";

describe("claude", () => {
  it("appends the text to the system prompt and excludes the replaced files", () => {
    const l = instructionsLaunch("claude", { text: TEXT, cwd: agent, replaces: [agent, path.dirname(agent)] });
    expect(l.systemPromptAppend).toBe(TEXT);
    expect(l.args[0]).toBe("--settings");
    const excludes = (JSON.parse(l.args[1]!) as { claudeMdExcludes: string[] }).claudeMdExcludes;
    expect(excludes).toContain(`${agent}/CLAUDE.md`);
    expect(excludes).toContain(`${agent}/AGENTS.md`);
    expect(excludes).toContain(`${agent}/.claude/rules/**`);
    expect(excludes).toContain(`${path.dirname(agent)}/CLAUDE.md`);
    // macOS: os.tmpdir() is under /var → /private/var
    expect(excludes).toContain(`${fs.realpathSync(agent)}/CLAUDE.md`);
    expect(l.stillLoaded).toEqual([]);
    expect(l.files).toEqual({});
  });

  it("escapes glob syntax in the directory", () => {
    expect(claudeInstructionExcludes(["/x/a (1)/b*"])[0]).toBe("/x/a \\(1\\)/b\\*/CLAUDE.md");
  });

  it("excludes nothing when nothing is replaced", () => {
    expect(instructionsLaunch("claude", { text: TEXT, cwd: agent }).args).toEqual([]);
  });
});

describe("codex", () => {
  it("passes developer instructions and turns AGENTS.md off when the cwd is replaced", () => {
    const l = instructionsLaunch("codex", { text: TEXT, cwd: agent, replaces: [agent] });
    expect(l.args).toEqual(["-c", `developer_instructions=${JSON.stringify(TEXT)}`, "-c", "project_doc_max_bytes=0"]);
    expect(l.systemPromptAppend).toBe("");
    expect(l.stillLoaded).toEqual([]);
  });

  it("keeps AGENTS.md on, and says so, when only a parent is replaced", () => {
    const parent = path.dirname(agent);
    const l = instructionsLaunch("codex", { text: TEXT, cwd: agent, replaces: [parent] });
    expect(l.args).not.toContain("project_doc_max_bytes=0");
    expect(l.stillLoaded).toContain(path.join(parent, "AGENTS.md"));
  });
});

describe("agy", () => {
  it("writes the text as always-on rules of a workspace plugin and reports AGENTS.md", () => {
    const l = instructionsLaunch("agy", { text: TEXT, cwd: agent, replaces: [agent] });
    const dir = ".agents/plugins/synapse-instructions";
    expect(JSON.parse(l.files[`${dir}/plugin.json`]!)).toEqual({ name: "synapse-instructions" });
    expect(l.files[`${dir}/rules/instructions-01.md`]).toBe(`---\ntrigger: always_on\n---\n\n${TEXT}`);
    expect(l.files[`${dir}/rules/instructions-02.md`]).toBe("---\ntrigger: manual\n---\n");
    expect(Object.keys(l.files)).toHaveLength(1 + AGY_RULE_SLOTS);
    expect(l.stillLoaded).toEqual([path.join(agent, "AGENTS.md"), path.join(agent, "GEMINI.md")]);
  });

  it("always writes every slot, so a shorter text leaves no stale rule", () => {
    const long = Array.from({ length: 3 }, (_, i) => `# ${i}\n${"あ".repeat(6000)}`).join("\n");
    const files = agyInstructionsPluginFiles(long);
    const live = Object.values(files).filter((c) => c.includes("always_on"));
    expect(live.length).toBe(3);
    expect(Object.keys(files)).toEqual(Object.keys(agyInstructionsPluginFiles("x")));
  });

  it("refuses a text longer than the slots hold", () => {
    expect(() => agyInstructionsPluginFiles("a\n".repeat(AGY_RULE_BYTES * AGY_RULE_SLOTS))).toThrow(/too long/);
  });

  it("withdraws to empty manual rules", () => {
    const files = withdrawInstructionsFiles("agy");
    expect(Object.values(files).filter((c) => c.includes("always_on"))).toEqual([]);
    expect(withdrawInstructionsFiles("claude")).toEqual({});
  });
});

describe("chunkInstructions", () => {
  it("keeps every byte, splitting at headings first", () => {
    const text = ["# a", "x".repeat(15000), "## b", "y".repeat(15000), "## c", "z"].join("\n");
    const chunks = chunkInstructions(text);
    expect(chunks.every((c) => Buffer.byteLength(c) <= AGY_RULE_BYTES)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
    expect(chunks[1]!.startsWith("## b")).toBe(true);
  });

  it("splits an over-long line", () => {
    const text = "あ".repeat(20000);
    const chunks = chunkInstructions(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
});

describe("empty text", () => {
  it("changes nothing for any CLI", () => {
    for (const cli of ["claude", "codex", "agy"] as const) {
      expect(instructionsLaunch(cli, { text: "  \n", cwd: agent, replaces: [agent] })).toEqual({
        cli,
        systemPromptAppend: "",
        args: [],
        files: {},
        stillLoaded: [],
      });
    }
  });
});
