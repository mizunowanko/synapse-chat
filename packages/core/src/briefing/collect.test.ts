import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { absorb, detectMarkUps } from "./collect.js";
import { withFingerprint } from "./markdown.js";
import { render, handOutAll } from "./hand-out.js";
import type { Briefing } from "./types.js";

const base: Briefing = {
  name: "Amanatsu",
  displayName: "アマナツ",
  role: "Atelier vault の分析担当。",
  sections: [
    { heading: "役割", body: "数字を読む。\n" },
    { heading: "作法", body: "数える前に定義を確かめる。\n" },
  ],
  skills: [
    {
      name: "analytics-inspect",
      description: "アナリティクスの数字を読む手順。",
      body: "1. 日次の推移を読み取る\n",
      providerFrontmatter: { claude: { "allowed-tools": "Read, Grep" } },
    },
  ],
  subagents: [
    {
      name: "number-cruncher",
      description: "集計を回す。",
      instructions: 'まず定義を確認する。\n"引用" と \\ を含む。\n',
    },
  ],
  rules: [{ name: "常時ルール", body: "推測で数字を出さない。\n" }],
};

let dir: string;

function write(relative: string, content: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(relative: string): string {
  return readFileSync(join(dir, relative), "utf-8");
}

/** Lays the whole rendered tree down on disk, the way a consumer's CLI would. */
function renderToDisk(spec: Briefing): void {
  for (const [relative, content] of Object.entries(handOutAll(spec))) write(relative, content);
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "agent-spec-absorb-")), "Amanatsu");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dirname(dir), { recursive: true, force: true });
});

describe("detectMarkUps", () => {
  it("reports nothing right after a render, and still nothing after a re-render", () => {
    // The failure this guards against is the tool crying wolf on every run: if
    // the digest is taken over anything other than what stripping leaves
    // behind, every file reads as edited forever and the warning stops meaning
    // anything.
    renderToDisk(base);
    expect(detectMarkUps(base, dir)).toEqual([]);
    renderToDisk(base);
    expect(detectMarkUps(base, dir)).toEqual([]);
  });

  it("reports nothing when the directory has not been rendered at all", () => {
    // Absent is not edited — that is just a fresh checkout.
    expect(detectMarkUps(base, dir)).toEqual([]);
  });

  it("names the edited file and every target that renders it", () => {
    renderToDisk(base);
    write("CLAUDE.md", `${read("CLAUDE.md")}\n## 追記\n\n手で足した。\n`);
    expect(detectMarkUps(base, dir)).toEqual([{ path: "CLAUDE.md", targets: ["claude"] }]);

    // AGENTS.md is shared, so it legitimately answers to two targets.
    write("AGENTS.md", `${read("AGENTS.md")}\n## 追記\n\n手で足した。\n`);
    expect(detectMarkUps(base, dir)).toEqual([
      { path: "AGENTS.md", targets: ["agents", "codex"] },
      { path: "CLAUDE.md", targets: ["claude"] },
    ]);
  });

  it("reports a hand-authored file that carries no marker", () => {
    // Never silently overwrite the only on-disk copy of somebody's prose.
    write("CLAUDE.md", "# 手書き\n\nこれは生成物ではない。\n");
    expect(detectMarkUps(base, dir, ["claude"])).toEqual([
      { path: "CLAUDE.md", targets: ["claude"] },
    ]);
  });

  it("ignores files under the provider directories that render never produces", () => {
    renderToDisk(base);
    write(".claude/notes.md", "無関係なメモ。\n");
    expect(detectMarkUps(base, dir)).toEqual([]);
  });
});

describe("absorb", () => {
  it("is a no-op when nothing was touched", () => {
    renderToDisk(base);
    for (const target of ["claude", "agents", "codex"] as const) {
      const result = absorb(base, target, dir);
      expect(result.absorbed).toEqual([]);
      expect(result.spec).toEqual(base);
    }
  });

  it("carries an edit made in CLAUDE.md over to AGENTS.md", () => {
    // The headline behaviour: edit whichever instruction file is in front of
    // you, and every other provider gets it on the next render.
    renderToDisk(base);
    write("CLAUDE.md", read("CLAUDE.md").replace("数字を読む。", "数字を読む。ただし出典を添える。"));

    const { spec, absorbed } = absorb(base, "claude", dir);
    expect(absorbed).toEqual(["CLAUDE.md"]);
    expect(spec.sections[0]?.body).toBe("数字を読む。ただし出典を添える。\n");

    const files = handOutAll(spec);
    expect(files["AGENTS.md"]).toContain("ただし出典を添える。");
    expect(files["CLAUDE.md"]).toBe(files["AGENTS.md"]);
  });

  it("carries an edit made in AGENTS.md over to CLAUDE.md", () => {
    renderToDisk(base);
    write("AGENTS.md", `${read("AGENTS.md")}\n## 新しい章\n\nagy 側で足した。\n`);

    const { spec } = absorb(base, "agents", dir);
    expect(spec.sections.map((section) => section.heading)).toEqual(["役割", "作法", "新しい章"]);

    const files = handOutAll(spec);
    expect(files["CLAUDE.md"]).toContain("agy 側で足した。");
    expect(files["CLAUDE.md"]).toBe(files["AGENTS.md"]);
  });

  it("does not let the marker leak into the spec when a human appends below it", () => {
    // People type at the bottom of the file, which puts their text *after* the
    // marker. If stripping were end-anchored the marker would survive into the
    // spec as prose and be re-rendered under a second marker.
    renderToDisk(base);
    write("CLAUDE.md", `${read("CLAUDE.md")}## 末尾追記\n\nマーカーの下に書いた。\n`);

    const { spec } = absorb(base, "claude", dir);
    expect(spec.sections.map((section) => section.heading)).toEqual(["役割", "作法", "末尾追記"]);
    const rendered = handOutAll(spec)["CLAUDE.md"] ?? "";
    expect(rendered).toContain("マーカーの下に書いた。");
    expect(rendered.match(/briefing:v1/g)).toHaveLength(1);
  });

  it("keeps a folded rule a rule rather than promoting it to a section", () => {
    renderToDisk(base);
    write("CLAUDE.md", read("CLAUDE.md").replace("推測で数字を出さない。", "推測で数字を出さない。必ず出典。"));

    const { spec } = absorb(base, "claude", dir);
    expect(spec.rules).toEqual([{ name: "常時ルール", body: "推測で数字を出さない。必ず出典。\n" }]);
    expect(spec.sections.map((section) => section.heading)).toEqual(["役割", "作法"]);
  });

  it("survives render → absorb → render as a fixed point", () => {
    renderToDisk(base);
    write("CLAUDE.md", `${read("CLAUDE.md")}\n## 追記\n\n一度だけ足す。\n`);

    const once = absorb(base, "claude", dir).spec;
    renderToDisk(once);
    expect(detectMarkUps(once, dir)).toEqual([]);

    const twice = absorb(once, "claude", dir).spec;
    expect(twice).toEqual(once);
    // The appended section must appear once, not once per pass.
    expect(read("CLAUDE.md").match(/一度だけ足す。/g)).toHaveLength(1);
  });

  it("absorbs a skill body and leaves another target's frontmatter alone", () => {
    renderToDisk(base);
    const skill = ".claude/skills/analytics-inspect/SKILL.md";
    write(skill, read(skill).replace("1. 日次の推移を読み取る", "1. 週次の推移を読み取る"));

    const { spec, absorbed } = absorb(base, "claude", dir);
    expect(absorbed).toEqual([skill]);
    expect(spec.skills[0]?.body).toBe("1. 週次の推移を読み取る\n");
    // `allowed-tools` was in the rendered Claude frontmatter and comes back.
    expect(spec.skills[0]?.providerFrontmatter).toEqual({ claude: { "allowed-tools": "Read, Grep" } });
  });

  it("does not drop another target's frontmatter when absorbing from agy", () => {
    // `.agents/skills/…` never carried `allowed-tools`, so absorbing it must
    // not read "the Claude entry is gone".
    renderToDisk(base);
    const skill = ".agents/skills/analytics-inspect/SKILL.md";
    write(skill, read(skill).replace("1. 日次の推移を読み取る", "1. 月次の推移を読み取る"));

    const { spec } = absorb(base, "agents", dir);
    expect(spec.skills[0]?.body).toBe("1. 月次の推移を読み取る\n");
    expect(spec.skills[0]?.providerFrontmatter).toEqual({ claude: { "allowed-tools": "Read, Grep" } });
  });

  it("absorbs a Codex subagent from TOML", () => {
    renderToDisk(base);
    const file = ".codex/agents/number-cruncher.toml";
    write(file, read(file).replace("まず定義を確認する。", "まず定義と単位を確認する。"));

    const { spec, absorbed } = absorb(base, "codex", dir);
    expect(absorbed).toEqual([file]);
    expect(spec.subagents[0]?.instructions).toBe('まず定義と単位を確認する。\n"引用" と \\ を含む。\n');

    // …and it reaches the Markdown-shaped providers.
    expect(handOutAll(spec)[".claude/agents/number-cruncher.md"]).toContain("定義と単位");
  });

  it("absorbs a Markdown subagent", () => {
    renderToDisk(base);
    const file = ".claude/agents/number-cruncher.md";
    write(file, read(file).replace("集計を回す。", "集計と検算を回す。"));

    const { spec } = absorb(base, "claude", dir);
    expect(spec.subagents[0]?.description).toBe("集計と検算を回す。");
    expect(handOutAll(spec)[".codex/agents/number-cruncher.toml"]).toContain("集計と検算を回す。");
  });

  it("picks up a skill somebody added by dropping a directory in", () => {
    renderToDisk(base);
    write(
      ".claude/skills/hand-written/SKILL.md",
      "---\nname: hand-written\ndescription: 手で足したスキル。\n---\n\n本文。\n",
    );

    const { spec } = absorb(base, "claude", dir);
    expect(spec.skills.map((skill) => skill.name)).toEqual(["analytics-inspect", "hand-written"]);
    // It reaches the other providers, which is the point of picking it up.
    expect(handOutAll(spec)[".agents/skills/hand-written/SKILL.md"]).toContain("本文。");
  });

  it("leaves a spec entry alone when its file is missing", () => {
    // "Not on disk" is also what a fresh checkout looks like, and the spec is
    // the only copy of the text.
    renderToDisk(base);
    rmSync(join(dir, ".claude/skills/analytics-inspect"), { recursive: true });
    expect(absorb(base, "claude", dir).spec.skills).toEqual(base.skills);
  });

  it("bootstraps from a hand-authored instruction file with no marker", () => {
    write("CLAUDE.md", "# アマナツ\n\n新しい役割。\n\n## 役割\n\n書き下ろし。\n");
    const { spec, absorbed } = absorb(base, "claude", dir);
    expect(absorbed).toEqual(["CLAUDE.md"]);
    expect(spec.role).toBe("新しい役割。");
    expect(spec.sections).toEqual([{ heading: "役割", body: "書き下ろし。\n" }]);
    // A rule whose folded heading is gone from the file is gone from the spec.
    expect(spec.rules).toEqual([]);
  });

  it("does not mutate the spec it was given", () => {
    renderToDisk(base);
    write("CLAUDE.md", read("CLAUDE.md").replace("数字を読む。", "書き換えた。"));
    const before = structuredClone(base);
    absorb(base, "claude", dir);
    expect(base).toEqual(before);
  });

  it("keeps displayName unset when the title still matches the name", () => {
    const plain: Briefing = { ...base, displayName: undefined, sections: base.sections };
    delete (plain as { displayName?: string }).displayName;
    renderToDisk(plain);
    write("CLAUDE.md", read("CLAUDE.md").replace("数字を読む。", "書き換えた。"));

    const { spec } = absorb(plain, "claude", dir);
    expect(spec.displayName).toBeUndefined();
    expect(handOut(spec, "claude")["CLAUDE.md"]).toContain("# Amanatsu");
  });

  it("takes in a hand-written marker-free file exactly once", () => {
    // A file we wrote and a file a human wrote are both absorbed, but after the
    // next render the hand-written one carries a marker and stops being an edit.
    write(".claude/skills/hand-written/SKILL.md", withFingerprint("---\nname: hand-written\ndescription: d\n---\n\n本文。\n"));
    const { spec } = absorb(base, "claude", dir);
    renderToDisk(spec);
    expect(detectMarkUps(spec, dir)).toEqual([]);
  });
});
