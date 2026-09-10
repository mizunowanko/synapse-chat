import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collect, detectMarkUps, emptyBriefing } from "./collect.js";
import { withFingerprint } from "./fingerprint.js";
import { handOut, handOutAll } from "./hand-out.js";
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

function put(relative: string, content: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(relative: string): string {
  return readFileSync(join(dir, relative), "utf-8");
}

/** Lays a whole set of handouts down on disk, the way a consuming CLI would. */
function handOutToDisk(briefing: Briefing): void {
  for (const [relative, content] of Object.entries(handOutAll(briefing))) put(relative, content);
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "briefing-")), "Amanatsu");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dirname(dir), { recursive: true, force: true });
});

describe("detectMarkUps", () => {
  it("reports nothing right after handing out, and still nothing after handing out again", () => {
    // The failure this guards against is the tool crying wolf on every run: if
    // the fingerprint covers anything other than what stripping leaves behind,
    // every handout reads as marked-up forever and the warning stops meaning
    // anything.
    handOutToDisk(base);
    expect(detectMarkUps(base, dir)).toEqual([]);
    handOutToDisk(base);
    expect(detectMarkUps(base, dir)).toEqual([]);
  });

  it("reports nothing when nothing has been handed out at all", () => {
    // Absent is not marked-up — that is just a fresh checkout.
    expect(detectMarkUps(base, dir)).toEqual([]);
  });

  it("names the marked-up handout and every layout that produces it", () => {
    handOutToDisk(base);
    put("CLAUDE.md", `${read("CLAUDE.md")}\n## 追記\n\n手で足した。\n`);
    expect(detectMarkUps(base, dir)).toEqual([{ path: "CLAUDE.md", layouts: ["claude"] }]);

    // AGENTS.md is shared, so it legitimately answers to two layouts.
    put("AGENTS.md", `${read("AGENTS.md")}\n## 追記\n\n手で足した。\n`);
    expect(detectMarkUps(base, dir)).toEqual([
      { path: "AGENTS.md", layouts: ["agents", "codex"] },
      { path: "CLAUDE.md", layouts: ["claude"] },
    ]);
  });

  it("reports a hand-authored file that carries no fingerprint", () => {
    // Never quietly hand out over the only on-disk copy of somebody's prose.
    put("CLAUDE.md", "# 手書き\n\nこれは配布版ではない。\n");
    expect(detectMarkUps(base, dir, ["claude"])).toEqual([
      { path: "CLAUDE.md", layouts: ["claude"] },
    ]);
  });

  it("ignores files under the provider directories that are never handed out", () => {
    handOutToDisk(base);
    put(".claude/notes.md", "無関係なメモ。\n");
    expect(detectMarkUps(base, dir)).toEqual([]);
  });
});

describe("collect", () => {
  it("is a no-op when nobody wrote on anything", () => {
    handOutToDisk(base);
    for (const layout of ["claude", "agents", "codex"] as const) {
      const result = collect(base, layout, dir);
      expect(result.collected).toEqual([]);
      expect(result.briefing).toEqual(base);
    }
  });

  it("carries a write-in on CLAUDE.md over to AGENTS.md", () => {
    // The headline behaviour: write on whichever handout is in front of you,
    // and everyone else gets it the next time the briefing goes out.
    handOutToDisk(base);
    put("CLAUDE.md", read("CLAUDE.md").replace("数字を読む。", "数字を読む。ただし出典を添える。"));

    const { briefing, collected } = collect(base, "claude", dir);
    expect(collected).toEqual(["CLAUDE.md"]);
    expect(briefing.sections[0]?.body).toBe("数字を読む。ただし出典を添える。\n");

    const files = handOutAll(briefing);
    expect(files["AGENTS.md"]).toContain("ただし出典を添える。");
    expect(files["CLAUDE.md"]).toBe(files["AGENTS.md"]);
  });

  it("carries a write-in on AGENTS.md over to CLAUDE.md", () => {
    handOutToDisk(base);
    put("AGENTS.md", `${read("AGENTS.md")}\n## 新しい章\n\nagy 側で足した。\n`);

    const { briefing } = collect(base, "agents", dir);
    expect(briefing.sections.map((section) => section.heading)).toEqual(["役割", "作法", "新しい章"]);

    const files = handOutAll(briefing);
    expect(files["CLAUDE.md"]).toContain("agy 側で足した。");
    expect(files["CLAUDE.md"]).toBe(files["AGENTS.md"]);
  });

  it("does not let the fingerprint leak into the briefing when somebody writes below it", () => {
    // People write at the bottom of the page, which puts their text *after* the
    // fingerprint. If stripping were end-anchored the fingerprint would survive
    // into the briefing as prose and go back out under a second one.
    handOutToDisk(base);
    put("CLAUDE.md", `${read("CLAUDE.md")}## 末尾追記\n\n指紋の下に書いた。\n`);

    const { briefing } = collect(base, "claude", dir);
    expect(briefing.sections.map((section) => section.heading)).toEqual(["役割", "作法", "末尾追記"]);
    const handed = handOutAll(briefing)["CLAUDE.md"] ?? "";
    expect(handed).toContain("指紋の下に書いた。");
    expect(handed.match(/briefing:v1/g)).toHaveLength(1);
  });

  it("keeps a folded rule a rule rather than promoting it to a section", () => {
    handOutToDisk(base);
    put("CLAUDE.md", read("CLAUDE.md").replace("推測で数字を出さない。", "推測で数字を出さない。必ず出典。"));

    const { briefing } = collect(base, "claude", dir);
    expect(briefing.rules).toEqual([{ name: "常時ルール", body: "推測で数字を出さない。必ず出典。\n" }]);
    expect(briefing.sections.map((section) => section.heading)).toEqual(["役割", "作法"]);
  });

  it("survives handOut → collect → handOut as a fixed point", () => {
    handOutToDisk(base);
    put("CLAUDE.md", `${read("CLAUDE.md")}\n## 追記\n\n一度だけ足す。\n`);

    const once = collect(base, "claude", dir).briefing;
    handOutToDisk(once);
    expect(detectMarkUps(once, dir)).toEqual([]);

    const twice = collect(once, "claude", dir).briefing;
    expect(twice).toEqual(once);
    // The appended section must appear once, not once per pass.
    expect(read("CLAUDE.md").match(/一度だけ足す。/g)).toHaveLength(1);
  });

  it("collects a skill body and leaves another layout's frontmatter alone", () => {
    handOutToDisk(base);
    const skill = ".claude/skills/analytics-inspect/SKILL.md";
    put(skill, read(skill).replace("1. 日次の推移を読み取る", "1. 週次の推移を読み取る"));

    const { briefing, collected } = collect(base, "claude", dir);
    expect(collected).toEqual([skill]);
    expect(briefing.skills[0]?.body).toBe("1. 週次の推移を読み取る\n");
    // `allowed-tools` was in the Claude handout's frontmatter and comes back.
    expect(briefing.skills[0]?.providerFrontmatter).toEqual({
      claude: { "allowed-tools": "Read, Grep" },
    });
  });

  it("does not drop another layout's frontmatter when collecting from agy", () => {
    // `.agents/skills/…` never carried `allowed-tools`, so collecting it must
    // not read as "the Claude entry is gone".
    handOutToDisk(base);
    const skill = ".agents/skills/analytics-inspect/SKILL.md";
    put(skill, read(skill).replace("1. 日次の推移を読み取る", "1. 月次の推移を読み取る"));

    const { briefing } = collect(base, "agents", dir);
    expect(briefing.skills[0]?.body).toBe("1. 月次の推移を読み取る\n");
    expect(briefing.skills[0]?.providerFrontmatter).toEqual({
      claude: { "allowed-tools": "Read, Grep" },
    });
  });

  it("collects a Codex subagent from TOML", () => {
    handOutToDisk(base);
    const file = ".codex/agents/number-cruncher.toml";
    put(file, read(file).replace("まず定義を確認する。", "まず定義と単位を確認する。"));

    const { briefing, collected } = collect(base, "codex", dir);
    expect(collected).toEqual([file]);
    expect(briefing.subagents[0]?.instructions).toBe('まず定義と単位を確認する。\n"引用" と \\ を含む。\n');

    // …and it reaches the Markdown-shaped layouts.
    expect(handOutAll(briefing)[".claude/agents/number-cruncher.md"]).toContain("定義と単位");
  });

  it("collects a Markdown subagent", () => {
    handOutToDisk(base);
    const file = ".claude/agents/number-cruncher.md";
    put(file, read(file).replace("集計を回す。", "集計と検算を回す。"));

    const { briefing } = collect(base, "claude", dir);
    expect(briefing.subagents[0]?.description).toBe("集計と検算を回す。");
    expect(handOutAll(briefing)[".codex/agents/number-cruncher.toml"]).toContain("集計と検算を回す。");
  });

  it("picks up a skill somebody added by dropping a directory in", () => {
    handOutToDisk(base);
    put(
      ".claude/skills/hand-written/SKILL.md",
      "---\nname: hand-written\ndescription: 手で足したスキル。\n---\n\n本文。\n",
    );

    const { briefing } = collect(base, "claude", dir);
    expect(briefing.skills.map((skill) => skill.name)).toEqual(["analytics-inspect", "hand-written"]);
    // It reaches the other providers, which is the point of picking it up.
    expect(handOutAll(briefing)[".agents/skills/hand-written/SKILL.md"]).toContain("本文。");
  });

  it("leaves a briefing entry alone when its handout is missing", () => {
    // "Not on disk" is also what a fresh checkout looks like, and the briefing
    // is the only copy of the text.
    handOutToDisk(base);
    rmSync(join(dir, ".claude/skills/analytics-inspect"), { recursive: true });
    expect(collect(base, "claude", dir).briefing.skills).toEqual(base.skills);
  });

  it("does not mutate the briefing it was given", () => {
    handOutToDisk(base);
    put("CLAUDE.md", read("CLAUDE.md").replace("数字を読む。", "書き換えた。"));
    const before = structuredClone(base);
    collect(base, "claude", dir);
    expect(base).toEqual(before);
  });

  it("keeps displayName unset while the title still matches the name", () => {
    const plain: Briefing = { ...base };
    delete plain.displayName;
    handOutToDisk(plain);
    put("CLAUDE.md", read("CLAUDE.md").replace("数字を読む。", "書き換えた。"));

    const { briefing } = collect(plain, "claude", dir);
    expect(briefing.displayName).toBeUndefined();
    expect(handOut(briefing, "claude")["CLAUDE.md"]).toContain("# Amanatsu");
  });

  it("takes in a hand-written fingerprint-free file exactly once", () => {
    // A handout we wrote and a file a human wrote are both collected, but once
    // it has been handed out it carries a fingerprint and stops being a mark-up.
    put(
      ".claude/skills/hand-written/SKILL.md",
      withFingerprint("---\nname: hand-written\ndescription: d\n---\n\n本文。\n"),
    );
    const { briefing } = collect(base, "claude", dir);
    handOutToDisk(briefing);
    expect(detectMarkUps(briefing, dir)).toEqual([]);
  });
});

// `collect` doubles as the migration bootstrap: a directory that was never
// handed out carries no fingerprints, so every file in it reads as marked-up
// and is taken in whole. That is why there is no separate `importFrom`.
describe("collect — bootstrapping a directory that was never handed out", () => {
  it("lifts a Claude-shaped directory into a briefing", () => {
    put(
      "CLAUDE.md",
      [
        "# アマナツ",
        "",
        "Atelier vault の分析担当。",
        "",
        "## 役割",
        "",
        "数字を読む。",
        "",
        "## 作法",
        "",
        "```md",
        "## これは見出しではない",
        "```",
        "",
        "定義を先に決める。",
        "",
      ].join("\n"),
    );
    put(
      ".claude/skills/analytics-inspect/SKILL.md",
      "---\nname: analytics-inspect\ndescription: 数字を読む手順。\nallowed-tools: Read, Grep\n---\n\n1. 推移を読む\n",
    );
    put(
      ".claude/agents/number-cruncher.md",
      "---\nname: number-cruncher\ndescription: 集計。\n---\n\n定義を確認する。\n",
    );
    put(".claude/rules/no-guessing.md", "推測で数字を出さない。\n");

    const { briefing } = collect(emptyBriefing("Amanatsu"), "claude", dir);

    expect(briefing.name).toBe("Amanatsu");
    expect(briefing.displayName).toBe("アマナツ");
    expect(briefing.role).toBe("Atelier vault の分析担当。");
    expect(briefing.sections.map((s) => s.heading)).toEqual(["役割", "作法"]);
    // The fenced sample must have stayed inside 作法, not become a section.
    expect(briefing.sections[1]?.body).toContain("## これは見出しではない");

    expect(briefing.skills).toHaveLength(1);
    expect(briefing.skills[0]?.name).toBe("analytics-inspect");
    expect(briefing.skills[0]?.description).toBe("数字を読む手順。");
    expect(briefing.skills[0]?.providerFrontmatter).toEqual({
      claude: { "allowed-tools": "Read, Grep" },
    });

    expect(briefing.subagents).toEqual([
      { name: "number-cruncher", description: "集計。", instructions: "定義を確認する。\n" },
    ]);
    // A legacy `.claude/rules/` file becomes a rule, and will be folded into
    // the instruction file from now on.
    expect(briefing.rules).toEqual([{ name: "no-guessing", body: "推測で数字を出さない。\n" }]);
  });

  it("survives collect → handOut → collect without drift", () => {
    put("CLAUDE.md", "# アマナツ\n\n分析担当。\n\n## 役割\n\n数字を読む。\n");
    put(".claude/skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n\nbody\n");
    put(".claude/rules/r.md", "推測しない。\n");

    const first = handOutAll(collect(emptyBriefing("Amanatsu"), "claude", dir).briefing);
    for (const [relative, content] of Object.entries(first)) put(relative, content);

    const second = handOutAll(collect(emptyBriefing("Amanatsu"), "claude", dir).briefing);
    expect(second).toEqual(first);
    // The folded rule appears exactly once, not once per round trip. The legacy
    // `.claude/rules/r.md` is still on disk — handing out never deletes — so
    // without name-matching it would be collected a second time.
    expect(second["CLAUDE.md"]?.match(/推測しない。/g)).toHaveLength(1);
    expect(second["CLAUDE.md"]?.match(/## r/g)).toHaveLength(1);
  });

  it("bootstraps from the codex layout too", () => {
    // `importFrom` used to throw here. Once TOML could be read there was no
    // reason left to keep Codex write-only.
    put("AGENTS.md", "# アマナツ\n\n分析担当。\n\n## 役割\n\n数字を読む。\n");
    put(
      ".codex/agents/keeper.toml",
      'name = "keeper"\ndescription = "番人。"\ndeveloper_instructions = """\n合言葉を守る。\n"""\n',
    );

    const { briefing } = collect(emptyBriefing("Amanatsu"), "codex", dir);
    expect(briefing.role).toBe("分析担当。");
    expect(briefing.subagents).toEqual([
      { name: "keeper", description: "番人。", instructions: "合言葉を守る。\n" },
    ]);
  });

  it("collects nothing from an empty directory instead of throwing", () => {
    // A missing instruction file is not an error: it just has not been handed
    // out yet.
    const { briefing, collected } = collect(emptyBriefing("Amanatsu"), "claude", dir);
    expect(collected).toEqual([]);
    expect(briefing).toEqual(emptyBriefing("Amanatsu"));
  });
});
