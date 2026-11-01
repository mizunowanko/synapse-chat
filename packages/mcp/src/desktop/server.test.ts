import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApprovalClient } from "./approval.js";
import type { DesktopAccessState } from "./contract.js";
import { createHelperClient, type HelperClient } from "./helper-client.js";
import { DESKTOP_INSTRUCTIONS, createDesktopMcpServer } from "./server.js";

const DESK = "desk-123";
const TOKEN = "tok_desk";
const HOUR = 3600_000;

const INSTALLED: Record<string, { bundleId: string; name: string }> = {
  textedit: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
  "com.apple.textedit": { bundleId: "com.apple.TextEdit", name: "TextEdit" },
  safari: { bundleId: "com.apple.Safari", name: "Safari" },
  notes: { bundleId: "com.apple.Notes", name: "Notes" },
};

// ---------------------------------------------------------------------------
// A fake helper: the socket protocol, the single-session lock, a fixed screen.

interface FakeHelper {
  socketPath: string;
  seen: Record<string, unknown>[];
  /** The next reply per op (once), instead of the default. */
  override: Map<string, Record<string, unknown>>;
  holder: string | undefined;
  abort(): void;
  close(): Promise<void>;
}

/** The screen: 1000x500 pixels covering 2000x1000 points at (100, 50). */
const SHOT = { data: "aW1n", mimeType: "image/jpeg", width: 1000, height: 500, originX: 100, originY: 50, pointWidth: 2000, pointHeight: 1000, backingScale: 2 };

async function startFakeHelper(socketPath: string): Promise<FakeHelper> {
  const conns = new Set<net.Socket>();
  const owners = new Map<string, net.Socket>();
  const h: FakeHelper = {
    socketPath,
    seen: [],
    override: new Map(),
    holder: undefined,
    abort() {
      const id = h.holder;
      h.holder = undefined;
      for (const c of conns) c.write(JSON.stringify({ event: "aborted", session: id, by: "esc" }) + "\n");
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of conns) c.destroy();
        server.close(() => r());
      }),
  };
  let allowed: { apps: string[]; inputApps: string[] } = { apps: [], inputApps: [] };
  const reply = (c: net.Socket, req: Record<string, unknown>): Record<string, unknown> => {
    const o = h.override.get(req.op as string);
    if (o) {
      h.override.delete(req.op as string);
      return o;
    }
    const session = req.session as string | undefined;
    switch (req.op) {
      case "resolveApps":
        return {
          ok: true,
          result: {
            apps: (req.apps as string[]).map((q) => ({ query: q, bundleId: INSTALLED[q.toLowerCase()]?.bundleId ?? null, name: INSTALLED[q.toLowerCase()]?.name ?? null, path: null })),
          },
        };
      case "beginSession":
        if (h.holder && h.holder !== session && owners.get(h.holder) && !owners.get(h.holder)!.destroyed) {
          return { ok: false, reason: "locked", error: "Another session holds the desktop.", holder: h.holder };
        }
        h.holder = session;
        owners.set(session!, c);
        allowed = { apps: req.apps as string[], inputApps: req.inputApps as string[] };
        return { ok: true, result: { session } };
      case "endSession":
        if (h.holder === session) h.holder = undefined;
        return { ok: true, result: {} };
      default:
        if (h.holder !== session) return { ok: false, reason: "no-session", error: "No session." };
        if (req.op === "screenshot") return { ok: true, result: { ...SHOT, apps: allowed.apps.filter((a) => a !== "com.apple.Notes") } };
        if (req.op === "cursor") return { ok: true, result: { x: 1100, y: 550 } };
        return { ok: true, result: { app: { bundleId: allowed.inputApps[0] } } };
    }
  };
  const server = net.createServer((c) => {
    conns.add(c);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        h.seen.push(req);
        c.write(JSON.stringify({ id: req.id, ...reply(c, req) }) + "\n");
      }
    });
    c.on("close", () => conns.delete(c));
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return h;
}

// ---------------------------------------------------------------------------
// A fake approval API.

interface SeenHttp {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let api: string;
let receiver: http.Server;
let seenHttp: SeenHttp[];
/** What POST answers, then what each GET answers in turn (the last one repeats). */
let created: { status: number; body: unknown };
let polls: DesktopAccessState[];

let dir: string;
let helper: FakeHelper;
const clients: Client[] = [];
const helperClients: HelperClient[] = [];

const granted = (apps: string[], extra: Partial<DesktopAccessState> = {}): DesktopAccessState => ({
  requestId: "req-1",
  status: "granted",
  apps,
  expiresAt: new Date(Date.now() + HOUR).toISOString(),
  ...extra,
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsk-"));
  helper = await startFakeHelper(path.join(dir, "h.sock"));
  seenHttp = [];
  created = { status: 202, body: { requestId: "req-1", status: "pending" } };
  polls = [granted(["com.apple.TextEdit"])];
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seenHttp.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      let status = 200;
      let body: unknown;
      if (req.method === "POST") ({ status, body } = created);
      else body = polls.length > 1 ? polls.shift() : polls[0];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const h of helperClients.splice(0)) h.close();
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
  await helper.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Result {
  text: string;
  isError: boolean;
  structured?: Record<string, unknown>;
  images: { data: string; mimeType: string }[];
}

async function connect(opts: { now?: () => number; approvalTimeoutMs?: number; logFile?: string; sessionId?: string; launch?: () => Promise<void> } = {}) {
  const h = createHelperClient({ socketPath: helper.socketPath, launch: opts.launch ?? (async () => {}), connectTimeoutMs: 2000 });
  helperClients.push(h);
  const handle = createDesktopMcpServer({
    approval: createApprovalClient({ api, token: TOKEN, pollIntervalMs: 10 }),
    helper: h,
    deskId: DESK,
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 2000,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.logFile ? { logFile: opts.logFile } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(a);
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(b);
  clients.push(mcp);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const r = (await mcp.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return {
      text: r.content.filter((c) => c.type === "text").map((c) => c.text).join(""),
      isError: r.isError === true,
      structured: r.structuredContent,
      images: r.content.filter((c) => c.type === "image").map((c) => ({ data: c.data!, mimeType: c.mimeType! })),
    };
  };
  return { mcp, call };
}

const ops = (op: string) => helper.seen.filter((r) => r.op === op);

describe("tools/list", () => {
  it("offers the computer-use set, with the input tools annotated for a non-interactive Codex", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "cursor_position",
        "double_click",
        "key",
        "left_click",
        "left_click_drag",
        "left_mouse_down",
        "left_mouse_up",
        "list_granted_applications",
        "middle_click",
        "mouse_move",
        "open_application",
        "request_access",
        "right_click",
        "screenshot",
        "scroll",
        "triple_click",
        "type",
        "wait",
        "zoom",
      ].sort(),
    );
    const left = tools.find((t) => t.name === "left_click")!;
    expect(left.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tools.find((t) => t.name === "screenshot")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(mcp.getInstructions()).toBe(DESKTOP_INSTRUCTIONS);
    expect(DESKTOP_INSTRUCTIONS).not.toMatch(/familia|Desk/);
  });
});

describe("request_access: the approval API decides", () => {
  it("refuses screen and input before any grant, without touching the helper's screen", async () => {
    const { call } = await connect();
    const r = await call("screenshot");
    expect(r.isError).toBe(true);
    expect(r.structured?.reason).toBe("no-access");
    expect(ops("screenshot")).toHaveLength(0);
  });

  it("POSTs {deskId, apps, reason} with the token and no Origin, polls, and begins the helper session with what was granted", async () => {
    polls = [{ requestId: "req-1", status: "pending" }, granted(["com.apple.TextEdit", "com.apple.Safari"])];
    const { call } = await connect();
    const r = await call("request_access", { apps: ["TextEdit", "Safari"], reason: "メモを書く" });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      status: "granted",
      requestId: "req-1",
      apps: [
        { bundleId: "com.apple.TextEdit", name: "TextEdit", input: true },
        { bundleId: "com.apple.Safari", name: "Safari", input: false },
      ],
    });

    const post = seenHttp[0]!;
    expect(post).toMatchObject({ method: "POST", url: "/api/desktop/access" });
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.headers.origin).toBeUndefined();
    expect(JSON.parse(post.body)).toEqual({
      deskId: DESK,
      apps: [
        { query: "TextEdit", bundleId: "com.apple.TextEdit", name: "TextEdit", readOnly: false },
        { query: "Safari", bundleId: "com.apple.Safari", name: "Safari", readOnly: true },
      ],
      reason: "メモを書く",
    });
    const gets = seenHttp.filter((s) => s.method === "GET");
    expect(gets.length).toBe(2);
    expect(gets[0]!.url).toMatch(/^\/api\/desktop\/access\/req-1\?waitMs=\d+$/);

    const begin = ops("beginSession")[0]!;
    expect(begin).toMatchObject({ apps: ["com.apple.TextEdit", "com.apple.Safari"], inputApps: ["com.apple.TextEdit"] });
    expect(typeof begin.expiresAt).toBe("number");
  });

  it("keeps only what was asked, and honours readOnly from the app", async () => {
    polls = [granted(["com.apple.TextEdit", "com.apple.Notes", "com.evil.Extra"], { readOnly: ["com.apple.Notes"] })];
    const { call } = await connect();
    const r = await call("request_access", { apps: ["TextEdit", "Notes"], reason: "r" });
    expect(r.structured?.apps).toEqual([
      { bundleId: "com.apple.TextEdit", name: "TextEdit", input: true },
      { bundleId: "com.apple.Notes", name: "Notes", input: false },
    ]);
    expect(ops("beginSession")[0]).toMatchObject({ apps: ["com.apple.TextEdit", "com.apple.Notes"], inputApps: ["com.apple.TextEdit"] });
  });

  it("denied: an error with the person's message, no session", async () => {
    polls = [{ requestId: "req-1", status: "denied", message: "今はだめ" }];
    const { call } = await connect();
    const r = await call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect(r.isError).toBe(true);
    expect(r.structured).toMatchObject({ reason: "denied", error: "今はだめ", requestId: "req-1" });
    expect(ops("beginSession")).toHaveLength(0);
    expect((await call("left_click", { coordinate: [1, 1] })).structured?.reason).toBe("no-access");
  });

  it("an immediate answer to the POST needs no poll", async () => {
    created = { status: 200, body: granted(["com.apple.TextEdit"]) };
    const { call } = await connect();
    expect((await call("request_access", { apps: ["TextEdit"], reason: "r" })).structured?.status).toBe("granted");
    expect(seenHttp.map((s) => s.method)).toEqual(["POST"]);
  });

  it("pending past the wait: answers pending, and the same call later goes on with the same request", async () => {
    polls = [{ requestId: "req-1", status: "pending" }];
    const { call } = await connect({ approvalTimeoutMs: 100 });
    const first = await call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect(first.isError).toBe(false);
    expect(first.structured).toMatchObject({ status: "pending", requestId: "req-1" });
    expect((await call("list_granted_applications")).structured).toMatchObject({ status: "none", pendingRequestId: "req-1" });

    polls = [granted(["com.apple.TextEdit"])];
    const second = await call("request_access", { apps: ["com.apple.TextEdit"], reason: "r" });
    expect(second.structured?.status).toBe("granted");
    expect(seenHttp.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("an app that is not installed is refused before asking anyone", async () => {
    const { call } = await connect();
    const r = await call("request_access", { apps: ["TextEdit", "NoSuchApp"], reason: "r" });
    expect(r.structured).toMatchObject({ reason: "unknown-app", apps: ["NoSuchApp"] });
    expect(seenHttp).toHaveLength(0);
  });

  it("a grant without expiresAt is a bad response", async () => {
    polls = [{ requestId: "req-1", status: "granted", apps: ["com.apple.TextEdit"] }];
    const { call } = await connect();
    const r = await call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect(r.structured).toMatchObject({ reason: "server-unreachable", detail: "bad-response: HTTP 200" });
  });

  it("passes the app's refusal through", async () => {
    created = { status: 403, body: { error: "この Desk には許されていない", reason: "forbidden" } };
    const { call } = await connect();
    const r = await call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect(r.structured).toEqual({ error: "この Desk には許されていない", reason: "forbidden" });
  });
});

describe("expiry", () => {
  it("refuses everything once expiresAt has passed, and ends the helper session", async () => {
    let t = Date.now();
    const { call } = await connect({ now: () => t });
    await call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect((await call("screenshot")).isError).toBe(false);
    t += HOUR + 1;
    for (const tool of ["screenshot", "left_click", "type"]) {
      const r = await call(tool, { coordinate: [1, 1], text: "x" });
      expect(r.structured?.reason).toBe("expired");
    }
    expect((await call("list_granted_applications")).structured?.status).toBe("expired");
    await new Promise((r) => setTimeout(r, 50));
    expect(ops("endSession").length).toBeGreaterThan(0);
    expect(ops("click")).toHaveLength(0);
  });
});

describe("browsers are screenshot-only", () => {
  it("a grant of only a browser takes screenshots but refuses every input locally", async () => {
    polls = [granted(["com.apple.Safari"])];
    const { call } = await connect();
    await call("request_access", { apps: ["Safari"], reason: "r" });
    expect(ops("beginSession")[0]).toMatchObject({ apps: ["com.apple.Safari"], inputApps: [] });
    const shot = await call("screenshot");
    expect(shot.isError).toBe(false);
    for (const [tool, args] of [
      ["left_click", { coordinate: [10, 10] }],
      ["key", { text: "cmd+l" }],
      ["type", { text: "x" }],
      ["scroll", { coordinate: [10, 10], scroll_direction: "down" }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.structured?.reason).toBe("read-only");
    }
    expect(ops("click").concat(ops("key"), ops("type"), ops("scroll"))).toHaveLength(0);
  });

  it("with a browser and another app, the helper's not-allowed (the browser under the point) reaches the model", async () => {
    polls = [granted(["com.apple.TextEdit", "com.apple.Safari"])];
    const { call } = await connect();
    await call("request_access", { apps: ["TextEdit", "Safari"], reason: "r" });
    await call("screenshot");
    helper.override.set("click", { ok: false, reason: "not-allowed", error: "Safari is not allowed for input.", app: { bundleId: "com.apple.Safari" } });
    const r = await call("left_click", { coordinate: [10, 10] });
    expect(r.structured).toMatchObject({ reason: "not-allowed", app: { bundleId: "com.apple.Safari" } });
  });
});

describe("coordinates: screenshot pixels to points", () => {
  async function granted1() {
    const c = await connect();
    await c.call("request_access", { apps: ["TextEdit"], reason: "r" });
    return c;
  }

  it("needs a screenshot first", async () => {
    const { call } = await granted1();
    expect((await call("left_click", { coordinate: [10, 10] })).structured?.reason).toBe("no-screenshot");
  });

  it("returns the screenshot as image content, and converts with its scale and origin", async () => {
    const { call } = await granted1();
    const shot = await call("screenshot");
    expect(shot.images).toEqual([{ data: SHOT.data, mimeType: "image/jpeg" }]);
    expect(JSON.parse(shot.text)).toMatchObject({ width: 1000, height: 500, apps: ["com.apple.TextEdit"] });
    expect(ops("screenshot")[0]).toMatchObject({ maxWidth: 1456, maxHeight: 1456, format: "jpeg" });

    await call("left_click", { coordinate: [10, 20] });
    expect(ops("click")[0]).toMatchObject({ x: 120, y: 90, button: "left", count: 1, modifiers: [] });
    await call("double_click", { coordinate: [0, 0] });
    await call("triple_click", { coordinate: [999, 499] });
    await call("right_click", { coordinate: [500, 250], text: "cmd+shift" });
    expect(ops("click").slice(1)).toMatchObject([
      { x: 100, y: 50, count: 2 },
      { x: 2098, y: 1048, count: 3 },
      { x: 1100, y: 550, button: "right", modifiers: ["cmd", "shift"] },
    ]);
    await call("left_click_drag", { start_coordinate: [0, 0], coordinate: [100, 50] });
    expect(ops("drag")[0]).toMatchObject({ x: 100, y: 50, toX: 300, toY: 150 });
    await call("scroll", { coordinate: [1, 1], scroll_direction: "down", scroll_amount: 5 });
    await call("scroll", { coordinate: [1, 1], scroll_direction: "left" });
    expect(ops("scroll")).toMatchObject([
      { x: 102, y: 52, dx: 0, dy: -5 },
      { dx: 3, dy: 0 },
    ]);
    expect((await call("cursor_position")).structured).toEqual({ x: 500, y: 250 });
  });

  it("refuses a point outside the screenshot", async () => {
    const { call } = await granted1();
    await call("screenshot");
    for (const c of [[1000, 0], [-1, 0], [0, 500], ["a", 1], [1]]) {
      expect((await call("left_click", { coordinate: c })).structured?.reason).toBe("bad-request");
    }
    expect(ops("click")).toHaveLength(0);
  });

  it("zoom asks for the region in points and leaves the coordinate space alone", async () => {
    const { call } = await granted1();
    await call("screenshot");
    const z = await call("zoom", { region: [100, 50, 300, 150] });
    expect(z.images).toHaveLength(1);
    expect(ops("screenshot")[1]).toMatchObject({ region: { x: 300, y: 150, width: 400, height: 200 } });
    await call("left_click", { coordinate: [10, 20] });
    expect(ops("click")[0]).toMatchObject({ x: 120, y: 90 });
  });

  it("names what was granted but not on screen", async () => {
    polls = [granted(["com.apple.TextEdit", "com.apple.Notes"])];
    const { call } = await connect();
    await call("request_access", { apps: ["TextEdit", "Notes"], reason: "r" });
    expect(JSON.parse((await call("screenshot")).text)).toMatchObject({ notVisible: ["com.apple.Notes"] });
  });
});

describe("the single-session lock", () => {
  it("a second server is told locked while the first holds the desktop", async () => {
    const a = await connect({ sessionId: "session-a" });
    expect((await a.call("request_access", { apps: ["TextEdit"], reason: "r" })).isError).toBe(false);
    const b = await connect({ sessionId: "session-b" });
    const r = await b.call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect(r.structured).toMatchObject({ reason: "locked", holder: "session-a" });
    expect((await b.call("screenshot")).structured?.reason).toBe("locked");
    expect(helper.holder).toBe("session-a");
  });

  it("begins the session again when the helper lost it (restarted)", async () => {
    const { call } = await connect();
    await call("request_access", { apps: ["TextEdit"], reason: "r" });
    helper.holder = undefined;
    expect((await call("screenshot")).isError).toBe(false);
    expect(ops("beginSession")).toHaveLength(2);
  });
});

describe("abort (Esc)", () => {
  it("the helper's aborted event drops the grant; every tool says aborted until a new grant", async () => {
    const { call } = await connect();
    await call("request_access", { apps: ["TextEdit"], reason: "r" });
    await call("screenshot");
    helper.abort();
    await new Promise((r) => setTimeout(r, 50));
    for (const tool of ["screenshot", "left_click", "key"]) {
      expect((await call(tool, { coordinate: [1, 1], text: "a" })).structured?.reason).toBe("aborted");
    }
    expect((await call("list_granted_applications")).structured?.status).toBe("aborted");
    expect(await call("request_access", { apps: ["TextEdit"], reason: "r" })).toMatchObject({ isError: false });
    expect((await call("screenshot")).isError).toBe(false);
  });

  it("an aborted answer to a call does the same", async () => {
    const { call } = await connect();
    await call("request_access", { apps: ["TextEdit"], reason: "r" });
    await call("screenshot");
    helper.override.set("type", { ok: false, reason: "aborted", error: "aborted while typing" });
    expect((await call("type", { text: "hello" })).structured?.reason).toBe("aborted");
    expect((await call("screenshot")).structured?.reason).toBe("aborted");
  });
});

describe("other tools", () => {
  it("key, type, open_application, wait", async () => {
    const { call } = await connect();
    await call("request_access", { apps: ["TextEdit"], reason: "r" });
    await call("key", { text: "cmd+shift+a" });
    await call("type", { text: "こんにちは\n" });
    expect(ops("key")[0]).toMatchObject({ keys: "cmd+shift+a" });
    expect(ops("type")[0]).toMatchObject({ text: "こんにちは\n" });
    await call("open_application", { app: "textedit" });
    expect(ops("openApp")[0]).toMatchObject({ bundleId: "com.apple.TextEdit" });
    expect((await call("open_application", { app: "Notes" })).structured?.reason).toBe("not-allowed");
    expect((await call("wait", { duration: 0.01 })).structured).toEqual({ waited: 0.01 });
    expect((await call("wait", { duration: 31 })).structured?.reason).toBe("bad-request");
  });

  it("the log has no typed text and no image", async () => {
    const logFile = path.join(dir, "d.jsonl");
    const { call } = await connect({ logFile });
    await call("request_access", { apps: ["TextEdit"], reason: "r" });
    await call("screenshot");
    await call("type", { text: "秘密の文" });
    const text = fs.readFileSync(logFile, "utf8");
    expect(text).not.toContain("秘密の文");
    expect(text).not.toContain(SHOT.data);
    expect(text).toContain('"tool":"type"');
    expect(text).toContain('"length":4');
  });
});

describe("the helper connection", () => {
  it("starts the helper when the socket is missing, then connects", async () => {
    await helper.close();
    fs.rmSync(helper.socketPath, { force: true });
    let launched = 0;
    const { call } = await connect({
      launch: async () => {
        launched++;
        setTimeout(() => void startFakeHelper(helper.socketPath).then((h) => (helper = h)), 100);
      },
    });
    const r = await call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect(r.isError).toBe(false);
    expect(launched).toBe(1);
  });

  it("helper-unavailable when it cannot be started", async () => {
    await helper.close();
    fs.rmSync(helper.socketPath, { force: true });
    const { call } = await connect({
      launch: async () => {
        throw new Error("no app");
      },
    });
    const r = await call("request_access", { apps: ["TextEdit"], reason: "r" });
    expect(r.structured).toMatchObject({ reason: "helper-unavailable" });
    expect(r.text).toMatch(/no app/);
    helper = await startFakeHelper(helper.socketPath);
  });
});
