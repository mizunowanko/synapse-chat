import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { remarkIssueLink } from "./remark-issue-link.js";

function process(input: string, options?: { ownerRepo?: string }): string {
  const out = unified()
    .use(remarkParse)
    .use(remarkIssueLink, options ?? {})
    .use(remarkStringify)
    .processSync(input);
  return String(out);
}

describe("remarkIssueLink", () => {
  it("links plain #N using ownerRepo", () => {
    const out = process("see #42 for details", { ownerRepo: "foo/bar" });
    expect(out).toContain("[#42](https://github.com/foo/bar/issues/42)");
  });

  it("links owner/repo#N to the specified repo even when ownerRepo differs", () => {
    const out = process("check anthropics/admiral#99 please", {
      ownerRepo: "foo/bar",
    });
    expect(out).toContain(
      "[anthropics/admiral#99](https://github.com/anthropics/admiral/issues/99)",
    );
    expect(out).not.toContain("foo/bar/issues/99");
  });

  it("links owner/repo#N even without ownerRepo option", () => {
    const out = process("tracking anthropics/admiral#7");
    expect(out).toContain(
      "[anthropics/admiral#7](https://github.com/anthropics/admiral/issues/7)",
    );
  });

  it("does not link plain #N when ownerRepo is not provided", () => {
    const out = process("see #42 for details");
    expect(out).not.toContain("](https://github.com");
    expect(out).toContain("#42");
  });

  it("does not rewrite #N inside inline code", () => {
    const out = process("use `#42` literal", { ownerRepo: "foo/bar" });
    expect(out).not.toContain("](https://github.com/foo/bar/issues/42)");
    expect(out).toContain("`#42`");
  });

  it("does not rewrite #N inside fenced code blocks", () => {
    const out = process("```\nfoo #42 bar\n```\n", { ownerRepo: "foo/bar" });
    expect(out).not.toContain("](https://github.com");
    expect(out).toContain("foo #42 bar");
  });

  it("handles mixed plain and cross-repo references in the same paragraph", () => {
    const out = process("fix #10 and anthropics/admiral#20", {
      ownerRepo: "foo/bar",
    });
    expect(out).toContain("[#10](https://github.com/foo/bar/issues/10)");
    expect(out).toContain(
      "[anthropics/admiral#20](https://github.com/anthropics/admiral/issues/20)",
    );
    expect(out).not.toContain("foo/bar/issues/20");
  });
});
