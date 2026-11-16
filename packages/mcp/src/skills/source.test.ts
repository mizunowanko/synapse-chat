import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_SCOPE, agentScope, deskViewer, visibleScopes, type SkillScope, type SkillViewer } from "./scope.js";
import { createSkillsMcpServer, createSkillsToolHandler } from "./server.js";
import type { SkillSource } from "./source.js";
import { SkillStore, type PutSkillInput, type PutSkillResult, type SkillFile, type SkillRecord } from "./store.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** A source with no SQLite: what an app hands the server instead of a `SkillStore`. */
class MemorySource implements SkillSource {
  readonly records: SkillRecord[] = [];
  readonly attached = new Map<SkillRecord, readonly SkillFile[]>();
  readonly puts: { scope: SkillViewer; input: PutSkillInput }[] = [];

  private latestIn(scope: SkillScope, name: string): SkillRecord | undefined {
    return this.records
      .filter((r) => r.name === name && r.scope.agent === scope.agent && r.scope.desk === scope.desk)
      .at(-1);
  }

  list(viewer: SkillViewer): SkillRecord[] {
    const seen = new Map<string, SkillRecord>();
    for (const scope of visibleScopes(viewer)) {
      for (const r of this.records) {
        const latest = this.latestIn(scope, r.name);
        if (latest === r && !seen.has(r.name)) seen.set(r.name, r);
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  resolve(viewer: SkillViewer, name: string): SkillRecord | undefined {
    return this.list(viewer).find((r) => r.name === name);
  }

  files(record: SkillRecord): readonly SkillFile[] {
    return this.attached.get(record) ?? [];
  }

  put(scope: SkillViewer, input: PutSkillInput): PutSkillResult {
    this.puts.push({ scope, input });
    const prev = this.resolve(scope, input.name);
    const record: SkillRecord = {
      id: this.records.length + 1,
      name: input.name,
      version: this.records.filter((r) => r.name === input.name).length + 1,
      scope: { agent: scope.agent, desk: scope.desk },
      description: input.description ?? prev?.description ?? "",
      body: input.body,
      frontmatter: {},
      deleted: false,
      createdAt: "2026-11-16T00:00:00.000Z",
      author: input.author ?? "",
    };
    this.records.push(record);
    this.attached.set(record, input.files ?? (prev ? this.files(prev) : []));
    return { record, changed: true };
  }
}

let dir: string;
let source: MemorySource;

function seed(target: { put: SkillSource["put"] }): void {
  target.put(GLOBAL_SCOPE, {
    name: "readtime",
    description: "読了時間を出す",
    body: "scripts/readtime.sh を実行する",
    files: [{ path: "scripts/readtime.sh", mode: 0o755, content: enc("#!/bin/sh\necho receipt-v1\n") }],
  });
  target.put(GLOBAL_SCOPE, { name: "issue", description: "issue を書く\n（改行入り）", body: "global issue rules" });
  target.put(agentScope("A"), { name: "issue", description: "A の issue", body: "A の issue rules" });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-source-"));
  source = new MemorySource();
  seed(source);
  source.puts.length = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SkillSource", () => {
  it("SkillStore is one", () => {
    const store = SkillStore.open(path.join(dir, "skills.db"));
    try {
      const s: SkillSource = store;
      expect(s.list(GLOBAL_SCOPE)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("the handler runs on a source without SQLite: list, get (with files), put", () => {
    const h = createSkillsToolHandler({ store: source, viewer: agentScope("A"), cacheRoot: path.join(dir, "cache") });

    expect(h.call("list_skills", {}).content).toEqual([
      { type: "text", text: "- issue (v2・エージェント A): A の issue\n- readtime (v1・全員): 読了時間を出す" },
    ]);

    const got = h.call("get_skill", { name: "readtime" });
    const gotText = (got.content[0] as { text: string }).text;
    const skillDir = path.join(dir, "cache", "readtime@1");
    expect(gotText).toBe(
      `# skill: readtime (v1)\n\nこのスキルのディレクトリ: ${skillDir}\n` +
        "付属ファイル（手順書に出てくる相対パスは、このディレクトリからのもの）:\n" +
        `- ${path.join(skillDir, "scripts/readtime.sh")}\n\nscripts/readtime.sh を実行する`,
    );
    expect(fs.readFileSync(path.join(skillDir, "scripts/readtime.sh"), "utf8")).toContain("receipt-v1");

    const missing = h.call("get_skill", { name: "nope" });
    expect(missing.isError).toBe(true);

    const put = h.call("put_skill", { name: "mine", description: "自分の", body: "x" });
    expect(put.content).toEqual([{ type: "text", text: "mine を v1 として エージェント A の階層に書いた。" }]);
    expect(source.puts).toEqual([
      { scope: agentScope("A"), input: { name: "mine", body: "x", author: "mcp:A", description: "自分の" } },
    ]);
  });

  it("put_skill scope: desk hands the source the desk tier, with the legacy key to carry over from", () => {
    const viewer = deskViewer("A", "d-1", "研究");
    const h = createSkillsToolHandler({ store: source, viewer, cacheRoot: path.join(dir, "cache") });
    const put = h.call("put_skill", { name: "issue", body: "desk", scope: "desk" });
    expect(put.isError).toBeUndefined();
    expect((put.content[0] as { text: string }).text).toBe("issue を v3 として この Desk の階層に書いた。");
    expect(source.puts[0]?.scope).toEqual({ agent: "A", desk: "d-1", legacyDesk: "研究" });
  });

  it("an error thrown by the source is an error result", () => {
    const broken: SkillSource = {
      list: () => {
        throw new Error("source down");
      },
      resolve: source.resolve.bind(source),
      files: source.files.bind(source),
      put: source.put.bind(source),
    };
    const h = createSkillsToolHandler({ store: broken, viewer: agentScope("A"), cacheRoot: path.join(dir, "cache") });
    expect(h.call("list_skills", {})).toEqual({ content: [{ type: "text", text: "source down" }], isError: true });
  });

  it("createSkillsMcpServer takes a source; its instructions list what the source lists", () => {
    const handle = createSkillsMcpServer({ store: source, viewer: agentScope("A"), cacheRoot: path.join(dir, "cache") });
    expect(handle.instructions).toContain("- issue: A の issue");
    expect(handle.instructions).toContain("- readtime: 読了時間を出す");
  });

  it("the same skills give the same text from a source as from a SkillStore", () => {
    const store = SkillStore.open(path.join(dir, "skills.db"));
    try {
      seed(store);
      const cacheRoot = path.join(dir, "cache");
      for (const viewer of [GLOBAL_SCOPE, agentScope("A"), agentScope("B")]) {
        const fromStore = createSkillsToolHandler({ store, viewer, cacheRoot });
        const fromSource = createSkillsToolHandler({ store: source, viewer, cacheRoot });
        for (const [tool, args] of [
          ["list_skills", {}],
          ["get_skill", { name: "readtime" }],
          ["get_skill", { name: "issue" }],
          ["get_skill", { name: "nope" }],
        ] as const) {
          expect(fromSource.call(tool, args)).toEqual(fromStore.call(tool, args));
        }
        expect(createSkillsMcpServer({ store: source, viewer, cacheRoot }).instructions).toBe(
          createSkillsMcpServer({ store, viewer, cacheRoot }).instructions,
        );
      }
    } finally {
      store.close();
    }
  });
});
