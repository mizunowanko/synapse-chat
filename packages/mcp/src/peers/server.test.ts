import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPeersClient } from "./client.js";
import type { PeersListResponse } from "./contract.js";
import { PEERS_INSTRUCTIONS, createPeersMcpServer } from "./server.js";

const TOKEN = "tok_ABC-123";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Reply = { status: number; body: string; headers?: Record<string, string> } | "hang";

/** A fake app: records each request and answers with the next reply set for its path. */
let receiver: http.Server;
let api: string;
let seen: Seen[];
let replies: Map<string, Reply>;
let dir: string;
const clients: Client[] = [];

const LIST: PeersListResponse = {
  self: "toki-agents-familia",
  peers: [
    { address: "toki-agents-familia", agent: "Toki", displayName: "トキ", desk: "agents-familia", provider: "claude", state: "idle", self: true },
    { address: "tsukuyo-artiflow", agent: "Tsukuyo", displayName: "ツクヨ", desk: "artiflow", provider: "codex", state: "stopped", self: false },
  ],
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-server-"));
  seen = [];
  replies = new Map([
    ["/api/peers", { status: 200, body: JSON.stringify(LIST) }],
    ["/api/peers/messages", { status: 200, body: JSON.stringify({ id: "pm-1", to: "tsukuyo-artiflow", status: "delivered", woke: true }) }],
  ]);
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const path = url.replace(/^\/prefix/, "");
      const reply = replies.get(path) ?? { status: 404, body: "{}" };
      if (reply === "hang") return;
      res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connect(opts: { api?: string; timeoutMs?: number; logFile?: string } = {}) {
  const client = createPeersClient({ api: opts.api ?? api, token: TOKEN, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  const handle = createPeersMcpServer({ client, ...(opts.logFile ? { logFile: opts.logFile } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(a);
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(b);
  clients.push(mcp);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return { text: r.content.map((c) => c.text).join(""), isError: r.isError === true, structured: r.structuredContent };
  };
  return { mcp, call };
}

describe("tools/list", () => {
  it("offers list_peers and send_message, annotated so a non-interactive Codex runs them without approval", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["list_peers", "send_message"]);
    expect(byName.list_peers?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    // Without destructiveHint / openWorldHint false, `codex exec` refuses: "requires approval, but approval policy is never".
    expect(byName.send_message?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.send_message?.inputSchema).toMatchObject({ required: ["to", "message"], additionalProperties: false });
  });

  it("sends instructions at initialize, with no app's words in them", async () => {
    const { mcp } = await connect();
    expect(mcp.getInstructions()).toBe(PEERS_INSTRUCTIONS);
    expect(PEERS_INSTRUCTIONS).not.toMatch(/Desk|familia|Escalation/);
  });
});

describe("list_peers", () => {
  it("GETs /api/peers with the bearer token and no Origin, and hands the answer over as is", async () => {
    const { call } = await connect();
    const r = await call("list_peers");
    expect(r.isError).toBe(false);
    expect(r.structured).toEqual(LIST);
    expect(JSON.parse(r.text)).toEqual(LIST);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/peers", body: "" });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.headers.origin).toBeUndefined();
  });

  it("keeps a path prefix of the api URL", async () => {
    const { call } = await connect({ api: `${api}/prefix/` });
    await call("list_peers");
    expect(seen[0]!.url).toBe("/prefix/api/peers");
  });
});

describe("send_message", () => {
  it("POSTs { to, message } as JSON with the bearer token and no Origin", async () => {
    const { call } = await connect();
    const r = await call("send_message", { to: "tsukuyo-artiflow", message: "見てほしい\n<!-- x -->" });
    expect(r.isError).toBe(false);
    expect(r.structured).toEqual({ id: "pm-1", to: "tsukuyo-artiflow", status: "delivered", woke: true });
    const req = seen[0]!;
    expect(req).toMatchObject({ method: "POST", url: "/api/peers/messages" });
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.origin).toBeUndefined();
    // The sender is never in the body: the app takes it from the token.
    expect(JSON.parse(req.body)).toEqual({ to: "tsukuyo-artiflow", message: "見てほしい\n<!-- x -->" });
  });

  it("passes queued through", async () => {
    replies.set("/api/peers/messages", { status: 200, body: JSON.stringify({ id: "pm-2", to: "x-y", status: "queued", woke: false }) });
    const { call } = await connect();
    const r = await call("send_message", { to: "x-y", message: "m" });
    expect(r.structured).toMatchObject({ status: "queued", woke: false });
  });

  it("refuses empty arguments without calling the app", async () => {
    const { call } = await connect();
    for (const args of [{}, { to: "", message: "m" }, { to: "a-b", message: "  " }, { to: 1, message: "m" }]) {
      const r = await call("send_message", args);
      expect(r.isError).toBe(true);
      expect(r.structured?.reason).toBe("bad-request");
    }
    expect(seen).toHaveLength(0);
  });
});

describe("refusals: the app's reason and everything it added reach the model", () => {
  const cases: [string, number, Record<string, unknown>][] = [
    ["unauthorized", 401, {}],
    ["origin-refused", 403, {}],
    ["bad-request", 400, {}],
    ["too-long", 413, { limit: 20000 }],
    ["unknown-address", 404, { candidates: ["tsukuyo-artiflow", "tsukuyo-vistudy"] }],
    ["self", 400, {}],
    ["not-reachable", 409, { detail: "no-session" }],
    ["not-reachable", 503, { detail: "shutting-down" }],
    ["chain-limit", 409, { depth: 9, limit: 8 }],
    ["rate-limited", 429, { retryAfterSeconds: 3, scope: "pair" }],
    ["wake-failed", 502, { detail: "wake-failed: exited" }],
  ];
  for (const [reason, status, extra] of cases) {
    it(`${status} ${reason}`, async () => {
      const body = { error: `the app says ${reason}`, reason, ...extra };
      replies.set("/api/peers/messages", { status, body: JSON.stringify(body), headers: status === 429 ? { "Retry-After": "3" } : {} });
      const { call } = await connect();
      const r = await call("send_message", { to: "tsukuyo", message: "m" });
      expect(r.isError).toBe(true);
      expect(r.structured).toEqual(body);
      expect(r.text.split("\n")[0]).toBe(`send_message failed (${reason}): the app says ${reason}`);
      for (const v of Object.values(extra)) expect(r.text).toContain(JSON.stringify(v, null, 2).split("\n")[0]!);
    });
  }

  it("list_peers refusals too", async () => {
    replies.set("/api/peers", { status: 401, body: JSON.stringify({ error: "No valid peer token", reason: "unauthorized" }) });
    const { call } = await connect();
    const r = await call("list_peers");
    expect(r.isError).toBe(true);
    expect(r.structured).toEqual({ error: "No valid peer token", reason: "unauthorized" });
  });

  it("passes a reason it does not know through as is", async () => {
    replies.set("/api/peers/messages", { status: 418, body: JSON.stringify({ error: "new rule", reason: "some-new-code", extraField: 1 }) });
    const { call } = await connect();
    const r = await call("send_message", { to: "a-b", message: "m" });
    expect(r.structured).toEqual({ error: "new rule", reason: "some-new-code", extraField: 1 });
  });
});

describe("server-unreachable: the one code the MCP server makes", () => {
  it("when nothing listens", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const { call } = await connect({ api: `http://127.0.0.1:${port}` });
    const r = await call("send_message", { to: "a-b", message: "m" });
    expect(r.isError).toBe(true);
    expect(r.structured).toMatchObject({ reason: "server-unreachable", detail: "ECONNREFUSED" });
  });

  it("when the app answers without a reason, or not in JSON", async () => {
    replies.set("/api/peers/messages", { status: 500, body: "<html>oops</html>" });
    replies.set("/api/peers", { status: 200, body: "not json" });
    const { call } = await connect();
    const send = await call("send_message", { to: "a-b", message: "m" });
    expect(send.structured).toMatchObject({ reason: "server-unreachable", detail: "bad-response: HTTP 500" });
    const list = await call("list_peers");
    expect(list.structured).toMatchObject({ reason: "server-unreachable", detail: "bad-response: HTTP 200" });
  });

  it("when the app does not answer in time; a send says it may have gone through", async () => {
    replies.set("/api/peers/messages", "hang");
    const { call } = await connect({ timeoutMs: 200 });
    const r = await call("send_message", { to: "a-b", message: "m" });
    expect(r.structured).toMatchObject({ reason: "server-unreachable", detail: "timeout" });
    expect(r.text).toMatch(/may or may not have been delivered/);
  });
});

describe("log", () => {
  it("records each call without the token or the message text", async () => {
    const logFile = path.join(dir, "peers.jsonl");
    const { call } = await connect({ logFile });
    await call("list_peers");
    await call("send_message", { to: "tsukuyo-artiflow", message: "秘密の本文" });
    replies.set("/api/peers/messages", { status: 404, body: JSON.stringify({ error: "no", reason: "unknown-address", candidates: [] }) });
    await call("send_message", { to: "nobody", message: "秘密の本文" });
    const text = fs.readFileSync(logFile, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("秘密の本文");
    const calls = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === "tools/call");
    expect(calls).toMatchObject([
      { tool: "list_peers", isError: false, peers: 2 },
      { tool: "send_message", to: "tsukuyo-artiflow", length: 5, isError: false, id: "pm-1", status: "delivered", woke: true },
      { tool: "send_message", to: "nobody", isError: true, reason: "unknown-address", http: 404 },
    ]);
  });
});
