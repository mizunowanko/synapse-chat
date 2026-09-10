import { describe, expect, it } from "vitest";

import { parseFrontmatter, splitSections, withFrontmatter } from "./markdown.js";

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

describe("frontmatter", () => {
  it("round-trips through withFrontmatter / parseFrontmatter", () => {
    const raw = withFrontmatter({ name: "s", description: "説明", "allowed-tools": "Read, Grep" }, "本文\n");
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({ name: "s", description: "説明", "allowed-tools": "Read, Grep" });
    expect(body.trim()).toBe("本文");
  });

  it("treats a file with no frontmatter as all body", () => {
    expect(parseFrontmatter("just prose\n")).toEqual({ frontmatter: null, body: "just prose\n" });
  });

  it("does not mistake a horizontal rule further down for a frontmatter block", () => {
    const raw = "prose\n\n---\n\nmore prose\n";
    expect(parseFrontmatter(raw).frontmatter).toBeNull();
  });

  it("reports malformed frontmatter as absent instead of throwing", () => {
    // One unparseable skill must not fail the import of a whole agent.
    const { frontmatter, body } = parseFrontmatter("---\n- a\n- b\n---\n\nbody\n");
    expect(frontmatter).toBeNull();
    expect(body).toContain("- a");
  });
});
