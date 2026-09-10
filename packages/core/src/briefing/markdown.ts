/**
 * Markdown plumbing shared by `hand-out.ts` and `collect.ts`: fence-aware `## `
 * splitting, and frontmatter emission and parsing.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Fence-aware split on level-2 ATX headings.
 *
 * The naive `text.split(/^## /m)` breaks on any `## ` that happens to sit inside
 * a fenced code block — and instructions for an agent are full of fenced
 * Markdown samples. Fences are tracked here (``` and ~~~, any length ≥ 3, closed
 * only by a fence of the same character and at least the same length, per
 * CommonMark).
 */
export function splitSections(text: string): {
  preamble: string;
  sections: { heading: string; body: string }[];
} {
  const lines = text.split("\n");
  const sections: { heading: string; body: string }[] = [];
  const preambleLines: string[] = [];
  let current: { heading: string; body: string[] } | null = null;
  let fence: { char: string; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const delimiter = fenceMatch[1] ?? "";
      const info = fenceMatch[2] ?? "";
      const char = delimiter[0] ?? "";
      const length = delimiter.length;
      if (fence === null) {
        // An opening ``` fence may not carry a backtick in its info string.
        if (!(char === "`" && info.includes("`"))) fence = { char, length };
      } else if (char === fence.char && length >= fence.length && info.trim() === "") {
        fence = null;
      }
    }

    const headingMatch = fence === null ? /^## +(.*?)\s*#*\s*$/.exec(line) : null;
    if (headingMatch) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n") });
      current = { heading: (headingMatch[1] ?? "").trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preambleLines.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join("\n") });

  return {
    preamble: preambleLines.join("\n").trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.body.trim() })),
  };
}

/** Emits a `---`-delimited YAML frontmatter block followed by `body`. */
export function withFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The inverse of {@link withFrontmatter}. A file with no leading `---` block is
 * all body — that is not an error, it is a skill somebody wrote by hand.
 *
 * A frontmatter block that is not a YAML mapping (a list, a bare scalar, a
 * syntax error) is reported as absent rather than thrown, because the caller's
 * only recovery would be to treat it as absent anyway, and throwing here would
 * turn one malformed skill into a failed collection of the whole agent.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: null, body: raw };

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { frontmatter: null, body: raw };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: null, body: raw };
  }
  return { frontmatter: parsed as Record<string, unknown>, body: raw.slice(match[0].length) };
}
