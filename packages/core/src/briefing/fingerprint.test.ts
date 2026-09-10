import { describe, expect, it } from "vitest";

import {
  fingerprintOf,
  isMarkedUp,
  stripFingerprint,
  withFingerprint,
} from "./fingerprint.js";

describe("fingerprint", () => {
  it("round-trips content through withFingerprint / stripFingerprint", () => {
    const marked = withFingerprint("hello\n");
    expect(marked).toContain("<!-- briefing:v1 fingerprint=");
    expect(stripFingerprint(marked).content).toBe("hello\n");
    expect(stripFingerprint(marked).fingerprint).toBe(fingerprintOf("hello\n"));
  });

  it("uses a TOML comment for toml handouts", () => {
    const marked = withFingerprint('name = "x"\n', "toml");
    expect(marked).toContain("# briefing:v1 fingerprint=");
    expect(stripFingerprint(marked).content).toBe('name = "x"\n');
  });

  it("reports a marked-up handout, a pristine one, and a foreign file", () => {
    const marked = withFingerprint("hello\n");
    expect(isMarkedUp(marked)).toBe(false);
    expect(isMarkedUp(marked.replace("hello", "goodbye"))).toBe(true);
    // No marker at all: hand-authored, must never be silently overwritten.
    expect(isMarkedUp("hello\n")).toBe(true);
  });
});

describe("fingerprint placement", () => {
  it("strips a fingerprint somebody has pushed off the end of the file", () => {
    // People append to the bottom. An end-anchored regex stops finding the
    // marker the moment they do — and then the marker line itself is absorbed
    // into the spec as prose and re-rendered under a second marker.
    const appended = `${withFingerprint("hello\n")}おまけの一文。\n`;

    const { content, fingerprint } = stripFingerprint(appended);
    expect(content).toBe("hello\n\nおまけの一文。\n");
    expect(content).not.toContain("briefing:v1");
    expect(fingerprint).toBe(fingerprintOf("hello\n"));
    // The fingerprint no longer describes the content, which is the point.
    expect(isMarkedUp(appended)).toBe(true);
  });

  it("strips a TOML fingerprint pushed off the end of the file", () => {
    const appended = `${withFingerprint('name = "x"\n', "toml")}extra = 1\n`;
    expect(stripFingerprint(appended).content).toBe('name = "x"\n\nextra = 1\n');
    expect(stripFingerprint(appended).content).not.toContain("briefing:v1");
  });

  it("removes every fingerprint, so handing out again cannot stack them", () => {
    const stacked = `${withFingerprint("hello\n")}追記。\n${withFingerprint("ignored\n").trim()}\n`;
    expect(stripFingerprint(stacked).content).not.toContain("briefing:v1");
  });

  it("hashes exactly what stripping leaves behind", () => {
    // The fingerprint trap: if these two disagree by one byte, every file reads as
    // edited on every run and the tool never stops shouting.
    for (const body of ["hello\n", "hello\n\n\n", "a\n\nb", "# 見出し\n\n本文\n"]) {
      const marked = withFingerprint(body);
      const { content, fingerprint } = stripFingerprint(marked);
      expect(fingerprintOf(content)).toBe(fingerprint);
      expect(isMarkedUp(marked)).toBe(false);
    }
  });
});
