import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { materializeSkill } from "./materialize.js";
import {
  agySkillsPluginFiles,
  claudeSkillsMcpConfig,
  codexSkillsConfigArgs,
  codexSkillsConfigToml,
  skillsServerEntry,
} from "./registration.js";
import { GLOBAL_SCOPE, agentScope } from "./scope.js";
import { SkillStore } from "./store.js";

let dir: string;
let db: string;
let output: string[];

function write(rel: string, content: string, mode = 0o644): void {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
}

async function run(...argv: string[]): Promise<number> {
  return main([...argv, "--db", db], {});
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-cli-"));
  db = path.join(dir, "skills.db");
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (output.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (output.push(String(s)), true));
  write("src/readtime/SKILL.md", "---\nname: readtime\ndescription: 読了時間\nargument-hint: \"[text]\"\n---\n\nscripts/rt.sh を使う\n");
  write("src/readtime/scripts/rt.sh", "#!/bin/sh\necho rt\n", 0o755);
  write("src/readtime/scripts/__pycache__/x.pyc", "junk");
  write("src/issue/SKILL.md", "---\nname: issue\ndescription: issue を書く\n---\n\nrules\n");
  write("src/not-a-skill/README.md", "x");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open<T>(fn: (s: SkillStore) => T): T {
  const s = SkillStore.open(db);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

describe("import", () => {
  it("brings a whole skills directory in, with files and exec bits, without litter", async () => {
    expect(await run("import", path.join(dir, "src"), "--global")).toBe(0);
    open((s) => {
      expect(s.list(GLOBAL_SCOPE).map((r) => r.name)).toEqual(["issue", "readtime"]);
      const rt = s.resolve(GLOBAL_SCOPE, "readtime")!;
      expect(rt.frontmatter).toEqual({ "argument-hint": "[text]" });
      expect(s.files(rt).map((f) => [f.path, f.mode])).toEqual([["scripts/rt.sh", 0o755]]);
      const m = materializeSkill(path.join(dir, "cache"), rt.name, rt.version, s.files(rt));
      expect(execFileSync(m.files[0]!, { encoding: "utf8" }).trim()).toBe("rt");
    });
  });

  it("is idempotent: re-importing the same directory makes no versions", async () => {
    await run("import", path.join(dir, "src"), "--global");
    await run("import", path.join(dir, "src"), "--global");
    open((s) => expect(s.history("readtime")).toHaveLength(1));
    expect(output.join("")).toMatch(/unchanged readtime v1/);
  });

  it("into an agent tier", async () => {
    await run("import", path.join(dir, "src", "issue"), "--agent", "A");
    open((s) => {
      expect(s.resolve(agentScope("A"), "issue")?.body).toBe("rules");
      expect(s.resolve(GLOBAL_SCOPE, "issue")).toBeUndefined();
    });
  });

  it("refuses to write without naming the tier — nobody writes everyone by omission", async () => {
    await expect(run("import", path.join(dir, "src"))).rejects.toThrow(/--global か --agent/);
    await expect(run("rm", "issue")).rejects.toThrow(/--global か --agent/);
    open((s) => expect(s.history("issue")).toEqual([]));
  });

  it("--dry-run writes nothing", async () => {
    await run("import", path.join(dir, "src"), "--global", "--dry-run");
    open((s) => expect(s.list(GLOBAL_SCOPE)).toEqual([]));
  });
});

describe("export / list / rm / history", () => {
  beforeEach(async () => {
    await run("import", path.join(dir, "src"), "--global");
  });

  it("export round-trips SKILL.md and files", async () => {
    const out = path.join(dir, "out");
    await run("export", "--all", "--out", out);
    expect(fs.readFileSync(path.join(out, "readtime", "SKILL.md"), "utf8")).toBe(
      '---\nname: readtime\ndescription: 読了時間\nargument-hint: "[text]"\n---\n\nscripts/rt.sh を使う\n',
    );
    expect(fs.statSync(path.join(out, "readtime", "scripts", "rt.sh")).mode & 0o777).toBe(0o755);
    // and importing the export back is a no-op
    await run("import", out, "--global");
    open((s) => expect(s.history("readtime")).toHaveLength(1));
  });

  it("export does not overwrite an existing directory without --force", async () => {
    const out = path.join(dir, "out");
    await run("export", "issue", "--out", out);
    await expect(run("export", "issue", "--out", out)).rejects.toThrow(/--force/);
    expect(await run("export", "issue", "--out", out, "--force")).toBe(0);
  });

  it("list shows the agent's view; rm of an override falls back to everyone", async () => {
    write("a/issue/SKILL.md", "---\nname: issue\ndescription: A の issue\n---\n\nA rules\n");
    await run("import", path.join(dir, "a"), "--agent", "A");
    output = [];
    await run("list", "--agent", "A");
    expect(output.join("")).toMatch(/issue\tv2\tエージェント A\tA の issue/);
    await run("rm", "issue", "--agent", "A");
    open((s) => expect(s.resolve(agentScope("A"), "issue")?.body).toBe("rules"));
    output = [];
    await run("history", "issue");
    expect(output.join("").trim().split("\n").map((l) => l.split("\t").slice(0, 3).join(" "))).toEqual([
      "v1 live global",
      "v2 live agent",
      "v3 deleted agent",
    ]);
  });
});

describe("registration", () => {
  const launch = { db: "/abs/skills.db", agent: "Tsukuyo", desk: "artiflow", node: "/usr/bin/node", cli: "/pkg/cli.js" };

  it("every CLI gets the same command line, with identity as arguments", () => {
    expect(skillsServerEntry(launch)).toEqual({
      command: "/usr/bin/node",
      args: ["/pkg/cli.js", "serve", "--db", "/abs/skills.db", "--agent", "Tsukuyo", "--desk", "artiflow"],
    });
    expect(claudeSkillsMcpConfig(launch)).toEqual({ mcpServers: { skills: skillsServerEntry(launch) } });
  });

  it("codex: -c overrides and a config.toml table", () => {
    expect(codexSkillsConfigArgs(launch)).toEqual([
      "-c",
      'mcp_servers.skills.command="/usr/bin/node"',
      "-c",
      'mcp_servers.skills.args=["/pkg/cli.js", "serve", "--db", "/abs/skills.db", "--agent", "Tsukuyo", "--desk", "artiflow"]',
    ]);
    expect(codexSkillsConfigToml(launch)).toMatch(/^\[mcp_servers\.skills\]\ncommand = "\/usr\/bin\/node"\nargs = \[/);
  });

  it("agy: a workspace plugin", () => {
    const files = agySkillsPluginFiles(launch);
    expect(Object.keys(files)).toEqual([
      ".agents/plugins/synapse-skills/plugin.json",
      ".agents/plugins/synapse-skills/mcp_config.json",
    ]);
    expect(JSON.parse(files[".agents/plugins/synapse-skills/mcp_config.json"]!)).toEqual(claudeSkillsMcpConfig(launch));
  });

  it("refuses a relative db path and a desk without an agent", () => {
    expect(() => skillsServerEntry({ db: "skills.db" })).toThrow(/absolute/);
    expect(() => skillsServerEntry({ db: "/a.db", desk: "d" })).toThrow(/agent/);
  });
});
