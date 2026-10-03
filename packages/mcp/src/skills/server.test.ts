import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeSkill } from "./materialize.js";
import { GLOBAL_SCOPE, agentScope, deskScope, type SkillScope } from "./scope.js";
import { createSkillsMcpServer } from "./server.js";
import { SkillStore } from "./store.js";

const enc = (s: string) => new TextEncoder().encode(s);

let dir: string;
let cacheRoot: string;
let store: SkillStore;
const clients: Client[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-server-"));
  cacheRoot = path.join(dir, "cache");
  store = SkillStore.open(path.join(dir, "skills.db"));
  store.put(GLOBAL_SCOPE, {
    name: "readtime",
    description: "読了時間を出す",
    body: "scripts/readtime.sh を実行する",
    files: [{ path: "scripts/readtime.sh", mode: 0o755, content: enc("#!/bin/sh\necho receipt-v1\n") }],
  });
  store.put(GLOBAL_SCOPE, { name: "issue", description: "issue を書く\n（改行入り）", body: "global issue rules" });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connect(viewer: SkillScope, opts: { writable?: boolean; logFile?: string } = {}) {
  const handle = createSkillsMcpServer({ store, viewer, cacheRoot, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join(""), isError: r.isError === true };
  };
  return { client, call };
}

describe("instructions", () => {
  it("list the skills the session sees, one line each", async () => {
    store.put(agentScope("A"), { name: "mine", description: "A だけのスキル", body: "x" });
    const { client } = await connect(agentScope("A"));
    const ins = client.getInstructions() ?? "";
    expect(ins).toMatch(/get_skill/);
    expect(ins).toContain("- issue: issue を書く （改行入り）");
    expect(ins).toContain("- mine: A だけのスキル");
    expect(ins).toContain("- readtime: 読了時間を出す");
  });

  it("do not show another agent's skills", async () => {
    store.put(agentScope("B"), { name: "secret", description: "B のスキル", body: "x" });
    const { client } = await connect(agentScope("A"));
    expect(client.getInstructions()).not.toContain("secret");
  });
});

describe("tools/list", () => {
  it("marks the read tools readOnlyHint (non-interactive Codex refuses them otherwise)", async () => {
    const { client } = await connect(agentScope("A"));
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_skill", "list_skills", "put_skill"]);
    expect(byName.list_skills?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_skill?.annotations?.readOnlyHint).toBe(true);
    expect(byName.put_skill?.annotations?.readOnlyHint).toBe(false);
  });

  it("hides put_skill without an agent, or when read-only", async () => {
    for (const [viewer, writable] of [[GLOBAL_SCOPE, true], [agentScope("A"), false]] as const) {
      const { client, call } = await connect(viewer, { writable });
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_skill", "list_skills"]);
      expect((await call("put_skill", { name: "x", description: "d", body: "b" })).isError).toBe(true);
    }
    expect(store.history("x")).toEqual([]);
  });
});

describe("get_skill", () => {
  it("writes the attached script with its exec bit, and it runs", async () => {
    const { call } = await connect(agentScope("A"));
    const r = await call("get_skill", { name: "readtime" });
    const scriptPath = path.join(cacheRoot, "readtime@1", "scripts", "readtime.sh");
    expect(r.text).toContain(scriptPath);
    expect(r.text).toContain("scripts/readtime.sh を実行する");
    expect(fs.statSync(scriptPath).mode & 0o111).not.toBe(0);
    expect(execFileSync(scriptPath, { encoding: "utf8" }).trim()).toBe("receipt-v1");
  });

  it("a new version is written to a new directory; the old one stays", async () => {
    const { call } = await connect(agentScope("A"));
    await call("get_skill", { name: "readtime" });
    store.put(GLOBAL_SCOPE, {
      name: "readtime",
      body: "v2",
      files: [{ path: "scripts/readtime.sh", mode: 0o755, content: enc("#!/bin/sh\necho receipt-v2\n") }],
    });
    const r = await call("get_skill", { name: "readtime" });
    const v2 = path.join(cacheRoot, "readtime@2", "scripts", "readtime.sh");
    expect(r.text).toContain("readtime (v2)");
    expect(execFileSync(v2, { encoding: "utf8" }).trim()).toBe("receipt-v2");
    expect(execFileSync(path.join(cacheRoot, "readtime@1", "scripts", "readtime.sh"), { encoding: "utf8" }).trim()).toBe("receipt-v1");
  });

  it("returns the agent's override, not the everyone tier", async () => {
    store.put(agentScope("A"), { name: "issue", body: "A's issue rules" });
    const a = await connect(agentScope("A"));
    const b = await connect(agentScope("B"));
    expect((await a.call("get_skill", { name: "issue" })).text).toContain("A's issue rules");
    expect((await b.call("get_skill", { name: "issue" })).text).toContain("global issue rules");
  });

  it("an unknown skill is an error result, not a crash", async () => {
    const { call } = await connect(agentScope("A"));
    const r = await call("get_skill", { name: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/list_skills/);
  });

  it("logs tool calls when asked", async () => {
    const logFile = path.join(dir, "calls.jsonl");
    const { call } = await connect(agentScope("A"), { logFile });
    await call("get_skill", { name: "issue" });
    const line = JSON.parse(fs.readFileSync(logFile, "utf8").trim()) as { tool: string; args: { name: string } };
    expect(line).toMatchObject({ tool: "get_skill", args: { name: "issue" } });
  });
});

describe("put_skill — the write rule", () => {
  it("writes the session's agent tier, visible to that agent only", async () => {
    const a = await connect(agentScope("A"));
    const r = await a.call("put_skill", { name: "issue", body: "A wrote this" });
    expect(r.isError).toBe(false);
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("A wrote this");
    expect(store.resolve(agentScope("B"), "issue")?.body).toBe("global issue rules");
    expect(store.resolve(GLOBAL_SCOPE, "issue")?.body).toBe("global issue rules");
  });

  it("cannot reach the everyone tier: there is no argument that names it", async () => {
    const a = await connect(agentScope("A"));
    expect((await a.call("put_skill", { name: "issue", body: "x", scope: "global" })).isError).toBe(true);
    // An extra `agent` argument is ignored: the tier comes from the launch arguments only.
    await a.call("put_skill", { name: "issue", body: "aimed at B", agent: "B" });
    expect(store.resolve(GLOBAL_SCOPE, "issue")?.body).toBe("global issue rules");
    expect(store.resolve(agentScope("B"), "issue")?.body).toBe("global issue rules");
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("aimed at B");
  });

  it("scope: desk writes the session's desk tier", async () => {
    const d = await connect(deskScope("A", "d1"));
    expect((await d.call("put_skill", { name: "issue", body: "desk rules", scope: "desk" })).isError).toBe(false);
    expect(store.resolve(deskScope("A", "d1"), "issue")?.body).toBe("desk rules");
    expect(store.resolve(agentScope("A"), "issue")?.body).toBe("global issue rules");
  });

  it("scope: desk without a desk is refused", async () => {
    const a = await connect(agentScope("A"));
    const r = await a.call("put_skill", { name: "issue", body: "x", scope: "desk" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/--desk/);
  });

  it("carries the script over when only the prose changes", async () => {
    const a = await connect(agentScope("A"));
    await a.call("put_skill", { name: "readtime", body: "A's prose" });
    const got = await a.call("get_skill", { name: "readtime" });
    expect(got.text).toContain("A's prose");
    expect(got.text).toMatch(/readtime@\d+\/scripts\/readtime\.sh/);
  });

  it("files replace the attachments, with exec bits as asked", async () => {
    const a = await connect(agentScope("A"));
    await a.call("put_skill", {
      name: "tool",
      description: "道具",
      body: "run.sh",
      files: [{ path: "run.sh", content: "#!/bin/sh\necho mine\n", executable: true }],
    });
    const rec = store.resolve(agentScope("A"), "tool")!;
    const m = materializeSkill(cacheRoot, rec.name, rec.version, store.files(rec));
    expect(execFileSync(m.files[0]!, { encoding: "utf8" }).trim()).toBe("mine");
  });

  it("rejects a path that escapes the skill directory", async () => {
    const a = await connect(agentScope("A"));
    const r = await a.call("put_skill", { name: "evil", description: "d", body: "b", files: [{ path: "../../x", content: "x" }] });
    expect(r.isError).toBe(true);
    expect(store.history("evil")).toEqual([]);
  });
});
