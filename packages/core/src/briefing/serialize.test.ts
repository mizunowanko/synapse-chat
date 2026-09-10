import { describe, expect, it } from "vitest";

import { parseBriefing, serializeBriefing } from "./serialize.js";
import type { Briefing } from "./types.js";

const briefing: Briefing = {
  name: "Amanatsu",
  displayName: "アマナツ",
  role: "分析担当。",
  sections: [{ heading: "役割", body: "数字を読む。\n" }],
  skills: [
    {
      name: "s",
      description: "d",
      body: "body\n",
      providerFrontmatter: { claude: { "allowed-tools": "Read" } },
    },
  ],
  subagents: [{ name: "a", description: "d", instructions: "instructions\n" }],
  rules: [{ name: "r", body: "推測しない。\n" }],
};

describe("parseBriefing / serializeBriefing", () => {
  it("round-trips through YAML", () => {
    expect(parseBriefing(serializeBriefing(briefing))).toEqual(briefing);
  });

  it("keeps long Japanese prose on one line so a diff stays readable", () => {
    const long = "。".repeat(200);
    const yaml = serializeBriefing({ ...briefing, role: long });
    expect(parseBriefing(yaml).role).toBe(long);
  });

  it("rejects a briefing that would hand out a nameless section", () => {
    // A section with no heading produces a file that silently says nothing.
    expect(() => parseBriefing("name: X\nsections:\n  - body: hi\n")).toThrow(
      /sections\[0\]\.heading is required/,
    );
  });

  it("rejects a briefing with no name", () => {
    expect(() => parseBriefing("sections: []\n")).toThrow(/name is required/);
  });

  it("rejects an unknown layout in providerFrontmatter", () => {
    // `gemini` looks plausible and is wrong — agy reads the `agents` layout.
    expect(() =>
      parseBriefing(
        "name: X\nskills:\n  - name: s\n    providerFrontmatter:\n      gemini:\n        a: 1\n",
      ),
    ).toThrow(/not a known layout/);
  });
});
