import { describe, expect, it } from "vitest";

import { stripFingerprint } from "./fingerprint.js";
import { handOut, handOutAll, handOutInstructions } from "./hand-out.js";
import type { Briefing } from "./types.js";

const briefing: Briefing = {
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

describe("handOut", () => {
  it("emits the expected file set per layout", () => {
    expect(Object.keys(handOut(briefing, "claude")).sort()).toEqual([
      ".claude/agents/number-cruncher.md",
      ".claude/skills/analytics-inspect/SKILL.md",
      "CLAUDE.md",
    ]);
    expect(Object.keys(handOut(briefing, "agents")).sort()).toEqual([
      ".agents/agents/number-cruncher.md",
      ".agents/skills/analytics-inspect/SKILL.md",
      "AGENTS.md",
    ]);
    // Codex reads `.agents/skills/` too, so skills are handed out once and shared.
    expect(Object.keys(handOut(briefing, "codex")).sort()).toEqual([
      ".agents/skills/analytics-inspect/SKILL.md",
      ".codex/agents/number-cruncher.toml",
      "AGENTS.md",
    ]);
  });

  it("hands out CLAUDE.md and AGENTS.md byte-identically", () => {
    // The load-bearing invariant: agy and Codex share AGENTS.md, so any
    // per-provider wording is both unrepresentable and self-revealing.
    expect(handOut(briefing, "claude")["CLAUDE.md"]).toBe(handOut(briefing, "agents")["AGENTS.md"]);
    expect(handOut(briefing, "agents")["AGENTS.md"]).toBe(handOut(briefing, "codex")["AGENTS.md"]);
  });

  it("folds rules into the instruction body, and emits no rules directory", () => {
    const body = handOutInstructions(briefing);
    expect(body).toContain("## 常時ルール");
    expect(body).toContain("推測で数字を出さない。");
    for (const layout of ["claude", "agents", "codex"] as const) {
      expect(Object.keys(handOut(briefing, layout)).some((p) => p.includes("/rules/"))).toBe(false);
    }
  });

  it("places the title, role and sections in order", () => {
    expect(stripFingerprint(handOut(briefing, "claude")["CLAUDE.md"]).content).toBe(
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
        "数える前に定義を確かめる。",
        "",
        "## 常時ルール",
        "",
        "推測で数字を出さない。",
        "",
      ].join("\n"),
    );
  });

  it("applies provider frontmatter only to its own layout", () => {
    const claudeSkill = handOut(briefing, "claude")[".claude/skills/analytics-inspect/SKILL.md"];
    const agySkill = handOut(briefing, "agents")[".agents/skills/analytics-inspect/SKILL.md"];
    expect(claudeSkill).toContain("allowed-tools: Read, Grep");
    expect(agySkill).not.toContain("allowed-tools");
    // The body is identical regardless; only the harness header differs.
    expect(claudeSkill).toContain("1. 日次の推移を読み取る");
    expect(agySkill).toContain("1. 日次の推移を読み取る");
  });

  it("writes Codex subagents as TOML with escaped instructions", () => {
    const toml = handOut(briefing, "codex")[".codex/agents/number-cruncher.toml"];
    expect(toml).toContain('name = "number-cruncher"');
    expect(toml).toContain('description = "集計を回す。"');
    expect(toml).toContain("developer_instructions = \"\"\"");
    expect(toml).toContain('\\"引用\\"');
    expect(toml).toContain("\\\\ を含む");
    // The escaping must make the closing delimiter unreachable from content.
    expect(toml.match(/"""/g)).toHaveLength(2);
  });

  it("falls back to name when displayName is absent", () => {
    expect(handOutInstructions({ ...briefing, displayName: undefined }).split("\n")[0]).toBe("# Amanatsu");
  });
});

describe("handOutAll", () => {
  it("merges the three layouts into one tree", () => {
    expect(Object.keys(handOutAll(briefing)).sort()).toEqual([
      ".agents/agents/number-cruncher.md",
      ".agents/skills/analytics-inspect/SKILL.md",
      ".claude/agents/number-cruncher.md",
      ".claude/skills/analytics-inspect/SKILL.md",
      ".codex/agents/number-cruncher.toml",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
  });

  it("throws when two layouts disagree on a shared path", () => {
    // Guard against a future edit reintroducing per-provider wording: agy and
    // Codex would then silently race to write AGENTS.md.
    const diverging: Briefing = {
      ...briefing,
      skills: [
        {
          ...briefing.skills[0],
          providerFrontmatter: { agents: { extra: 1 }, codex: { extra: 2 } },
        },
      ],
    };
    expect(() => handOutAll(diverging)).toThrow(/disagree on \.agents\/skills/);
  });
});
