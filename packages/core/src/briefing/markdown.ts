/**
 * Markdown plumbing shared by `render.ts`, `import.ts` and `absorb.ts`:
 * fence-aware `## ` splitting, frontmatter emission and parsing, and the
 * provenance marker.
 */

import { createHash } from "node:crypto";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Trailing marker written into every generated file. It carries a digest of the
 * content *around* it, which lets us tell "untouched, safe to overwrite" from
 * "a human edited this" before anything gets clobbered, and lets `absorb()`
 * take the edit back into the spec.
 *
 * **The marker is matched anywhere, not just at the end.** People append to the
 * bottom of a file, which pushes the marker into the middle. An end-anchored
 * regex misses it there — and then the marker text itself gets absorbed into
 * the spec as prose and re-rendered underneath a second marker. Stripping is
 * therefore position-independent, and every marker line is removed.
 */
const FINGERPRINT_LINE_RE =
  /^[ \t]*(?:<!--[ \t]*briefing:v1 fingerprint=([0-9a-f]{16})[ \t]*-->|#[ \t]*briefing:v1 fingerprint=([0-9a-f]{16}))[ \t]*$/;

export function fingerprintOf(content: string): string {
  return createHash("sha256").update(normalizeTrailingNewline(content)).digest("hex").slice(0, 16);
}

/**
 * Collapse a run of trailing blank lines to exactly one `\n`.
 *
 * Every path that hashes or compares content funnels through here. That is the
 * point: the digest is taken over the *output* of stripping, so "what was
 * hashed" and "what is left after the marker comes off" cannot drift apart. A
 * one-byte disagreement between those two would mark every file as edited on
 * every run, forever.
 */
export function normalizeTrailingNewline(content: string): string {
  return `${content.replace(/\n+$/, "")}\n`;
}

export function withFingerprint(content: string, style: "markdown" | "toml" = "markdown"): string {
  const normalized = normalizeTrailingNewline(content);
  const marker =
    style === "toml"
      ? `# briefing:v1 fingerprint=${fingerprintOf(normalized)}`
      : `<!-- briefing:v1 fingerprint=${fingerprintOf(normalized)} -->`;
  return `${normalized}\n${marker}\n`;
}

/**
 * Splits a generated file into its content and the digest it was stamped with.
 *
 * All marker lines are removed wherever they sit; the last one wins as the
 * recorded digest, because a re-render appends the newest marker last.
 */
export function stripFingerprint(raw: string): { content: string; digest: string | null } {
  let digest: string | null = null;
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const match = FINGERPRINT_LINE_RE.exec(line);
    if (match) {
      digest = match[1] ?? match[2] ?? digest;
      continue;
    }
    kept.push(line);
  }
  return { content: normalizeTrailingNewline(kept.join("\n")), digest };
}

/**
 * True when the file carries our marker but its content no longer hashes to it —
 * i.e. somebody edited a generated file by hand. Files without a marker are not
 * ours and are reported as edited, so we never silently overwrite a
 * hand-authored `CLAUDE.md`.
 */
export function isMarkedUp(raw: string): boolean {
  const { content, digest } = stripFingerprint(raw);
  if (digest === null) return true;
  return fingerprintOf(content) !== digest;
}

/**
 * Fence-aware split on level-2 ATX headings.
 *
 * The naive `text.split(/^## /m)` breaks on any `## ` that happens to sit inside
 * a fenced code block — and agent instructions are full of fenced Markdown
 * samples. Fences are tracked here (``` and ~~~, any length ≥ 3, closed only by
 * a fence of the same character and at least the same length, per CommonMark).
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
 * turn one malformed skill into a failed import of the whole agent.
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
