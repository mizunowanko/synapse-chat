import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCacheRoot, materializeSkill } from "./materialize.js";

const enc = (s: string) => new TextEncoder().encode(s);
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-cache-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("materializeSkill", () => {
  it("writes <name>@<version>/ with modes, and nothing for a skill without files", () => {
    const m = materializeSkill(root, "s", 2, [
      { path: "a/run.sh", mode: 0o755, content: enc("x") },
      { path: "data.txt", mode: 0o644, content: enc("y") },
    ]);
    expect(m.dir).toBe(path.join(root, "s@2"));
    expect(fs.statSync(path.join(root, "s@2/a/run.sh")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, "s@2/data.txt")).mode & 0o777).toBe(0o644);
    expect(materializeSkill(root, "t", 1, [])).toEqual({ dir: undefined, files: [] });
    expect(fs.readdirSync(root).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("reuses a directory that already holds the same bytes", () => {
    const files = [{ path: "run.sh", mode: 0o755, content: enc("x") }];
    materializeSkill(root, "s", 1, files);
    const ino = fs.statSync(path.join(root, "s@1/run.sh")).ino;
    materializeSkill(root, "s", 1, files);
    expect(fs.statSync(path.join(root, "s@1/run.sh")).ino).toBe(ino);
  });

  it("replaces a same-named directory holding other bytes (another store's s@1)", () => {
    materializeSkill(root, "s", 1, [{ path: "run.sh", mode: 0o755, content: enc("other store") }]);
    fs.writeFileSync(path.join(root, "s@1/stray"), "left over");
    materializeSkill(root, "s", 1, [{ path: "run.sh", mode: 0o755, content: enc("this store") }]);
    expect(fs.readFileSync(path.join(root, "s@1/run.sh"), "utf8")).toBe("this store");
    expect(fs.existsSync(path.join(root, "s@1/stray"))).toBe(false);
  });

  it("defaults to ~/.cache/synapse-skills, honouring XDG_CACHE_HOME", () => {
    expect(defaultCacheRoot({ XDG_CACHE_HOME: "/x" })).toBe("/x/synapse-skills");
    expect(defaultCacheRoot({})).toBe(path.join(os.homedir(), ".cache", "synapse-skills"));
  });
});
