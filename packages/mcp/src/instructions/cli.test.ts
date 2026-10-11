import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { GLOBAL_INSTRUCTIONS, InstructionStore, agentInstructions } from "./store.js";

let dir: string;
let db: string;
let output: string[];

const run = (...argv: string[]): Promise<number> => main([...argv, "--db", db], {});
const text = (): string => output.join("");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-cli-"));
  db = path.join(dir, "skills.db");
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (output.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (output.push(String(s)), true));
  fs.writeFileSync(path.join(dir, "global.md"), "# 共通\n全員へ\n<!-- briefing:v1 fingerprint=0123456789abcdef -->\n");
  fs.writeFileSync(path.join(dir, "a.md"), "# A\nA へ\n");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("synapse-instructions", () => {
  it("import --dry-run does not create the store", async () => {
    expect(await run("import", path.join(dir, "global.md"), "--global", "--dry-run")).toBe(0);
    expect(text()).toMatch(/would import .*global\.md .* → 全員/);
    expect(fs.existsSync(db)).toBe(false);
  });

  it("a write must name its tier", async () => {
    await expect(run("import", path.join(dir, "a.md"))).rejects.toThrow(/--global か --agent/);
    await expect(run("import", path.join(dir, "a.md"), "--global", "--agent", "A")).rejects.toThrow(/同時/);
  });

  it("imports, lists, shows, exports and keeps history", async () => {
    await run("import", path.join(dir, "global.md"), "--global");
    await run("import", path.join(dir, "a.md"), "--agent", "A");
    await run("import", path.join(dir, "a.md"), "--agent", "A");
    expect(text()).toContain("unchanged エージェント A v1");

    output = [];
    await run("list");
    expect(text()).toMatch(/^全員\tv1\t/m);
    expect(text()).toMatch(/^エージェント A\tv1\t/m);

    output = [];
    await run("show", "--agent", "A", "--effective");
    expect(text().indexOf("# 共通")).toBeLessThan(text().indexOf("# A"));
    expect(text()).not.toContain("fingerprint");

    const out = path.join(dir, "out", "a.md");
    await run("export", "--agent", "A", "--out", out);
    expect(fs.readFileSync(out, "utf8")).toBe("# A\nA へ\n");
    await expect(run("export", "--agent", "A", "--out", out)).rejects.toThrow(/--force/);

    await run("rm", "--agent", "A");
    output = [];
    await run("history", "--agent", "A");
    expect(text().trim().split("\n").map((l) => l.split("\t").slice(0, 2).join(" "))).toEqual(["v1 live", "v2 deleted"]);

    const store = InstructionStore.open(db);
    expect(store.get(GLOBAL_INSTRUCTIONS)?.version).toBe(1);
    expect(store.get(agentInstructions("A"))).toBeUndefined();
    store.close();
  });

  it("launch prints the launch inputs", async () => {
    await run("import", path.join(dir, "global.md"), "--global");
    output = [];
    await run("launch", "codex", "--cwd", dir, "--agent", "A", "--replace", dir);
    const launch = JSON.parse(text()) as { args: string[] };
    expect(launch.args).toContain("project_doc_max_bytes=0");
  });
});
