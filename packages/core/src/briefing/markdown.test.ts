import { describe, expect, it } from "vitest";

import {
  fingerprintOf,
  isMarkedUp,
  parseFrontmatter,
  splitSections,
  stripFingerprint,
  withFrontmatter,
  withFingerprint,
} from "./markdown.js";

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
  it("round-trips content through withFingerprint / stripFingerprint", () => {
    const marked = withFingerprint("hello\n");
    expect(marked).toContain("<!-- briefing:v1 fingerprint=");
    expect(stripFingerprint(marked).content).toBe("hello\n");
    expect(stripFingerprint(marked).digest).toBe(fingerprintOf("hello\n"));
  });

  it("uses a TOML comment marker for toml files", () => {
    const marked = withFingerprint('name = "x"\n', "toml");
    expect(marked).toContain("# briefing:v1 fingerprint=");
    expect(stripFingerprint(marked).content).toBe('name = "x"\n');
  });

  it("reports an edited generated file, an untouched one, and a foreign one", () => {
    const marked = withFingerprint("hello\n");
    expect(isMarkedUp(marked)).toBe(false);
    expect(isMarkedUp(marked.replace("hello", "goodbye"))).toBe(true);
    // No marker at all: hand-authored, must never be silently overwritten.
    expect(isMarkedUp("hello\n")).toBe(true);
  });
});

describe("marker placement", () => {
  it("strips a marker a human has pushed off the end of the file", () => {
    // People append to the bottom. An end-anchored regex stops finding the
    // marker the moment they do — and then the marker line itself is absorbed
    // into the spec as prose and re-rendered under a second marker.
    const appended = `${withFingerprint("hello\n")}おまけの一文。\n`;

    const { content, digest } = stripFingerprint(appended);
    expect(content).toBe("hello\n\nおまけの一文。\n");
    expect(content).not.toContain("briefing:v1");
    expect(digest).toBe(fingerprintOf("hello\n"));
    // The digest no longer describes the content, which is the whole point.
    expect(isMarkedUp(appended)).toBe(true);
  });

  it("strips a TOML marker a human has pushed off the end of the file", () => {
    const appended = `${withFingerprint('name = "x"\n', "toml")}extra = 1\n`;
    expect(stripFingerprint(appended).content).toBe('name = "x"\n\nextra = 1\n');
    expect(stripFingerprint(appended).content).not.toContain("briefing:v1");
  });

  it("removes every marker, so re-rendering an appended file cannot stack them", () => {
    const stacked = `${withFingerprint("hello\n")}追記。\n${withFingerprint("ignored\n").trim()}\n`;
    expect(stripFingerprint(stacked).content).not.toContain("briefing:v1");
  });

  it("hashes exactly what stripping leaves behind", () => {
    // The digest trap: if these two disagree by one byte, every file reads as
    // edited on every run and the tool never stops shouting.
    for (const body of ["hello\n", "hello\n\n\n", "a\n\nb", "# 見出し\n\n本文\n"]) {
      const marked = withFingerprint(body);
      const { content, digest } = stripFingerprint(marked);
      expect(fingerprintOf(content)).toBe(digest);
      expect(isMarkedUp(marked)).toBe(false);
    }
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
