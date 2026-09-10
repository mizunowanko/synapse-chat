import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importFrom } from "./collect.js";
import { handOutAll } from "./hand-out.js";
import { parseBriefing, serializeBriefing } from "./serialize.js";

let dir: string;

function put(rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "agent-spec-")), "Amanatsu");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dirname(dir), { recursive: true, force: true });
});

describe("importFrom", () => {
  it("lifts a Claude-shaped directory into a spec", () => {
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
    put(".claude/agents/number-cruncher.md", "---\nname: number-cruncher\ndescription: 集計。\n---\n\n定義を確認する。\n");
    put(".claude/rules/no-guessing.md", "推測で数字を出さない。\n");

    const spec = importFrom(dir, "claude");

    expect(spec.name).toBe("Amanatsu");
    expect(spec.displayName).toBe("アマナツ");
    expect(spec.role).toBe("Atelier vault の分析担当。");
    expect(spec.sections.map((s) => s.heading)).toEqual(["役割", "作法"]);
    // The fenced sample must have stayed inside 作法, not become a section.
    expect(spec.sections[1].body).toContain("## これは見出しではない");

    expect(spec.skills).toHaveLength(1);
    expect(spec.skills[0].name).toBe("analytics-inspect");
    expect(spec.skills[0].description).toBe("数字を読む手順。");
    expect(spec.skills[0].providerFrontmatter).toEqual({ claude: { "allowed-tools": "Read, Grep" } });

    expect(spec.subagents).toEqual([
      { name: "number-cruncher", description: "集計。", instructions: "定義を確認する。\n" },
    ]);
    expect(spec.rules).toEqual([{ name: "no-guessing", body: "推測で数字を出さない。\n" }]);
  });

  it("survives a render → import → render round trip without drift", () => {
    put("CLAUDE.md", "# アマナツ\n\n分析担当。\n\n## 役割\n\n数字を読む。\n");
    put(".claude/skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n\nbody\n");
    put(".claude/rules/r.md", "推測しない。\n");

    const first = handOutAll(importFrom(dir, "claude"));
    for (const [rel, content] of Object.entries(first)) put(rel, content);

    const second = handOutAll(importFrom(dir, "claude"));
    expect(second).toEqual(first);
    // The folded rule appears exactly once, not once per round trip.
    expect(second["CLAUDE.md"].match(/推測しない。/g)).toHaveLength(1);
    expect(second["CLAUDE.md"].match(/## r/g)).toHaveLength(1);
  });

  it("refuses to import from codex", () => {
    put("AGENTS.md", "# A\n");
    expect(() => importFrom(dir, "codex")).toThrow(/not supported/);
  });

  it("reports a missing instruction file by path", () => {
    expect(() => importFrom(dir, "claude")).toThrow(/CLAUDE\.md not found/);
  });
});

describe("spec serialization", () => {
  it("round-trips through YAML", () => {
    put("CLAUDE.md", "# アマナツ\n\n分析担当。\n\n## 役割\n\n数字を読む。\n");
    put(".claude/skills/s/SKILL.md", "---\nname: s\ndescription: d\nallowed-tools: Read\n---\n\nbody\n");
    const spec = importFrom(dir, "claude");
    expect(parseBriefing(serializeBriefing(spec))).toEqual(spec);
  });

  it("rejects a spec that would render a nameless section", () => {
    expect(() => parseBriefing("name: X\nsections:\n  - body: hi\n")).toThrow(
      /sections\[0\]\.heading is required/,
    );
  });

  it("rejects an unknown provider frontmatter target", () => {
    expect(() =>
      parseBriefing("name: X\nskills:\n  - name: s\n    providerFrontmatter:\n      gemini:\n        a: 1\n"),
    ).toThrow(/not a known target/);
  });
});
