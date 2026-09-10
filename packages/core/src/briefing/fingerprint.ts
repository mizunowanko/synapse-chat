/**
 * The fingerprint: a content hash stamped into every handout so we can tell a
 * pristine copy from one somebody has written on.
 *
 * This is what makes collecting the handouts back in safe. A handout whose
 * content still hashes to its fingerprint carries no human input, so it can be
 * handed out again without asking. One that does not is **marked-up**, and its
 * text is the thing we came for.
 */

import { createHash } from "node:crypto";

/**
 * The fingerprint line, as written at the foot of a handout.
 *
 * **It is matched anywhere in the file, not just at the end.** People write at
 * the bottom of a page, which pushes the fingerprint into the middle. An
 * end-anchored pattern stops finding it the moment they do — and then the
 * fingerprint line itself is collected as if it were prose and handed back out
 * underneath a second one.
 */
const FINGERPRINT_LINE_RE =
  /^[ \t]*(?:<!--[ \t]*briefing:v1 fingerprint=([0-9a-f]{16})[ \t]*-->|#[ \t]*briefing:v1 fingerprint=([0-9a-f]{16}))[ \t]*$/;

export function fingerprintOf(content: string): string {
  return createHash("sha256").update(normalizeTrailingNewline(content)).digest("hex").slice(0, 16);
}

/**
 * Collapse a run of trailing blank lines to exactly one `\n`.
 *
 * Every path that hashes or compares content funnels through here, and that is
 * the point: the fingerprint is taken over the *output* of stripping, so "what
 * was hashed" and "what is left once the fingerprint comes off" cannot drift
 * apart. A one-byte disagreement between those two marks every handout as
 * marked-up on every run, forever.
 */
export function normalizeTrailingNewline(content: string): string {
  return `${content.replace(/\n+$/, "")}\n`;
}

/** Stamps `content` with its fingerprint, as a Markdown or TOML comment. */
export function withFingerprint(content: string, style: "markdown" | "toml" = "markdown"): string {
  const normalized = normalizeTrailingNewline(content);
  const line =
    style === "toml"
      ? `# briefing:v1 fingerprint=${fingerprintOf(normalized)}`
      : `<!-- briefing:v1 fingerprint=${fingerprintOf(normalized)} -->`;
  return `${normalized}\n${line}\n`;
}

/**
 * Splits a handout into its content and the fingerprint it was stamped with.
 *
 * Every fingerprint line is removed wherever it sits; the last one wins as the
 * recorded value, because handing out again appends the newest one last.
 */
export function stripFingerprint(raw: string): { content: string; fingerprint: string | null } {
  let fingerprint: string | null = null;
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const match = FINGERPRINT_LINE_RE.exec(line);
    if (match) {
      fingerprint = match[1] ?? match[2] ?? fingerprint;
      continue;
    }
    kept.push(line);
  }
  return { content: normalizeTrailingNewline(kept.join("\n")), fingerprint };
}

/**
 * True when somebody has written on this handout.
 *
 * A file carrying no fingerprint at all counts as marked-up: it is not one of
 * ours, so it is hand-authored by definition, and it must never be quietly
 * handed out over.
 */
export function isMarkedUp(raw: string): boolean {
  const { content, fingerprint } = stripFingerprint(raw);
  if (fingerprint === null) return true;
  return fingerprintOf(content) !== fingerprint;
}
