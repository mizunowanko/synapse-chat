import { describe, expect, it } from "vitest";

import { digestOf, isHandEdited, splitSections, stripMarker, withMarker } from "./markdown.js";

describe("splitSections", () => {
  it("splits on level-2 headings and keeps the preamble", () => {
    const { preamble, sections } = splitSections("intro line\n\n## First\n\nalpha\n\n## Second\n\nbeta\n");
    expect(preamble).toBe("intro line");
    expect(sections).toEqual([
      { heading: "First", body: "alpha" },
      { heading: "Second", body: "beta" },
    ]);
  });

  it("does not split on a '## ' that sits inside a fenced code block", () => {
    // Agent instructions are full of fenced Markdown samples; a naive
    // `split(/^## /m)` shreds the section that contains one.
    const text = [
      "## Real",
      "",
      "```md",
      "## Not a heading",
      "still inside the fence",
      "```",
      "",
      "tail of Real",
      "",
      "## Also real",
      "",
      "beta",
    ].join("\n");

    const { sections } = splitSections(text);
    expect(sections.map((s) => s.heading)).toEqual(["Real", "Also real"]);
    expect(sections[0].body).toContain("## Not a heading");
    expect(sections[0].body).toContain("tail of Real");
  });

  it("handles tilde fences and longer fences that contain a shorter one", () => {
    const text = ["## Real", "", "~~~~", "```", "## nope", "```", "~~~~", "", "tail"].join("\n");
    const { sections } = splitSections(text);
    expect(sections.map((s) => s.heading)).toEqual(["Real"]);
    expect(sections[0].body).toContain("## nope");
  });

  it("ignores deeper headings", () => {
    const { sections } = splitSections("## Top\n\n### Nested\n\nbody\n");
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toBe("### Nested\n\nbody");
  });
});

describe("marker", () => {
  it("round-trips content through withMarker / stripMarker", () => {
    const marked = withMarker("hello\n");
    expect(marked).toContain("<!-- agent-spec:v1 digest=");
    expect(stripMarker(marked).content).toBe("hello\n");
    expect(stripMarker(marked).digest).toBe(digestOf("hello\n"));
  });

  it("uses a TOML comment marker for toml files", () => {
    const marked = withMarker('name = "x"\n', "toml");
    expect(marked).toContain("# agent-spec:v1 digest=");
    expect(stripMarker(marked).content).toBe('name = "x"\n');
  });

  it("reports an edited generated file, an untouched one, and a foreign one", () => {
    const marked = withMarker("hello\n");
    expect(isHandEdited(marked)).toBe(false);
    expect(isHandEdited(marked.replace("hello", "goodbye"))).toBe(true);
    // No marker at all: hand-authored, must never be silently overwritten.
    expect(isHandEdited("hello\n")).toBe(true);
  });
});
