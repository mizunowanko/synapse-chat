/**
 * The stdio MCP server that lets a CLI session see and operate macOS apps
 * (docs/design/desktop-mcp.md), with tools close to Anthropic's computer-use
 * tool set. One process per session.
 *
 * It decides nothing about permission: `request_access` asks the app's
 * approval API (contract.ts) and keeps what a person granted, until it
 * expires or the user presses Esc. On top of the grant it enforces only what
 * holds for everyone: browsers are screenshot-only, and an expired grant
 * refuses everything. The native helper (desktop-helper/) checks the same
 * grant again for every screenshot and every event.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, type ApprovalClient } from "./approval.js";
import type {
  DesktopAccessState,
  DesktopAppRequest,
  DesktopRefusal,
  HelperResolvedApp,
  HelperResponse,
  HelperScreenshot,
} from "./contract.js";
import type { HelperClient } from "./helper-client.js";
import { isBrowser, toPixel, toPoint, toPointRect, type ScreenGeometry } from "./policy.js";

export const DESKTOP_SERVER_NAME = "desktop";
export const DESKTOP_SERVER_VERSION = "1";

/** The long edge Claude reads without downscaling; the helper fits screenshots inside it. */
export const DEFAULT_SCREENSHOT_MAX = 1456;

export interface DesktopServerOptions {
  readonly approval: ApprovalClient;
  readonly helper: HelperClient;
  /** Who asks, sent with every access request. */
  readonly deskId: string;
  /** How long one request_access waits for the person before answering `pending`. Default 45 s. */
  readonly approvalTimeoutMs?: number;
  /** Append one JSON line per event (no image, no typed text). */
  readonly logFile?: string;
  /** The id the helper's session lock knows this server by. Default: a random UUID. */
  readonly sessionId?: string;
  readonly screenshot?: { maxWidth?: number; maxHeight?: number; format?: "png" | "jpeg"; quality?: number };
  /** For tests. */
  readonly now?: () => number;
}

export interface DesktopServerHandle {
  readonly server: Server;
  readonly instructions: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const DESKTOP_INSTRUCTIONS =
  "このサーバーは macOS のデスクトップのアプリを見て操作する。" +
  "最初に request_access で使うアプリと理由を伝え、人の承認を待つ（status が pending なら、同じ引数でもう一度呼ぶ）。" +
  "スクリーンショットに写るのは承認されたアプリのウィンドウだけで、操作できるのもそれだけ。ブラウザは見るだけで、クリックもキー入力もできない。" +
  "座標は直前の screenshot の画素で指定する（zoom の画像の画素ではない）。操作のあとは screenshot で結果を確かめる。" +
  "ユーザーが Esc を押すと止まり、以後のツールは aborted を返す。そのときは作業をやめ、ユーザーに確かめてから request_access し直す。";

const coordinate = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
  description: "[x, y]: 直前の screenshot の画素",
} as const;

// Input tools: destructiveHint / openWorldHint false so a non-interactive
// Codex does not refuse them (peers-mcp.md). The gate is request_access and
// the person behind it, not the CLI's approval prompt.
const INPUT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

function clickTool(name: string, what: string): Tool {
  return {
    name,
    description: `${what}。押しているあいだ保持する修飾キーを text に書ける（"shift"、"cmd+shift"）。`,
    inputSchema: {
      type: "object",
      properties: { coordinate, text: { type: "string", description: "保持する修飾キー（任意）" } },
      required: ["coordinate"],
      additionalProperties: false,
    },
    annotations: { title: name, ...INPUT },
  };
}

export const DESKTOP_TOOLS: readonly Tool[] = [
  {
    name: "request_access",
    description:
      "使うアプリへのアクセスを、理由を添えて人に求める。承認されるまで待ち、承認されたアプリ（bundle id）と期限を返す。" +
      "待ちきれなければ status: pending を返すので、同じ引数でもう一度呼ぶ。ブラウザは承認されても見るだけ。" +
      "呼び直すと前の承認は置き換わる。",
    inputSchema: {
      type: "object",
      properties: {
        apps: { type: "array", items: { type: "string" }, minItems: 1, description: "アプリの名前（TextEdit）か bundle id（com.apple.TextEdit）" },
        reason: { type: "string", description: "何のために使うか（承認する人が読む）" },
      },
      required: ["apps", "reason"],
      additionalProperties: false,
    },
    annotations: { title: "Request access", ...INPUT },
  },
  {
    name: "list_granted_applications",
    description: "いま承認されているアプリ（input: false は見るだけ）と期限、承認待ちの依頼を返す。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List granted applications", ...READ },
  },
  {
    name: "screenshot",
    description: "画面（メインディスプレイ）を撮る。承認されたアプリのウィンドウだけが写り、ほかは写らない。以後の座標はこの画像の画素。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Screenshot", readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  },
  clickTool("left_click", "左クリック"),
  clickTool("right_click", "右クリック"),
  clickTool("middle_click", "中クリック"),
  clickTool("double_click", "ダブルクリック"),
  clickTool("triple_click", "トリプルクリック（行の選択など）"),
  {
    name: "mouse_move",
    description: "ポインタを動かす。",
    inputSchema: { type: "object", properties: { coordinate }, required: ["coordinate"], additionalProperties: false },
    annotations: { title: "Mouse move", ...INPUT },
  },
  {
    name: "left_click_drag",
    description: "start_coordinate で押して coordinate まで引きずり、離す。",
    inputSchema: {
      type: "object",
      properties: { start_coordinate: coordinate, coordinate },
      required: ["start_coordinate", "coordinate"],
      additionalProperties: false,
    },
    annotations: { title: "Drag", ...INPUT },
  },
  {
    name: "left_mouse_down",
    description: "左ボタンを押したままにする（coordinate を省くといまの位置）。left_mouse_up と組で使う。",
    inputSchema: { type: "object", properties: { coordinate }, additionalProperties: false },
    annotations: { title: "Mouse down", ...INPUT },
  },
  {
    name: "left_mouse_up",
    description: "左ボタンを離す（coordinate を省くといまの位置）。",
    inputSchema: { type: "object", properties: { coordinate }, additionalProperties: false },
    annotations: { title: "Mouse up", ...INPUT },
  },
  {
    name: "scroll",
    description: "coordinate の位置でスクロールする。scroll_amount は行数（既定 3）。",
    inputSchema: {
      type: "object",
      properties: {
        coordinate,
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["coordinate", "scroll_direction"],
      additionalProperties: false,
    },
    annotations: { title: "Scroll", ...INPUT },
  },
  {
    name: "key",
    description:
      "キーを押す。修飾キーは + でつなぐ（\"cmd+shift+a\"、\"Return\"、\"ctrl+c\"、\"Escape\"、\"Page_Down\"、\"F5\"）。空白で区切ると順に押す。最前面のアプリに届く。",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    annotations: { title: "Key", ...INPUT },
  },
  {
    name: "type",
    description: "文字列を打つ（最前面のアプリに届く）。改行は Return になる。",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    annotations: { title: "Type", ...INPUT },
  },
  {
    name: "open_application",
    description: "承認されたアプリを開く（開いていれば前面に出す）。名前か bundle id。",
    inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"], additionalProperties: false },
    annotations: { title: "Open application", ...INPUT },
  },
  {
    name: "cursor_position",
    description: "ポインタの位置を、直前の screenshot の画素で返す。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Cursor position", readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "wait",
    description: "duration 秒待つ（最大 30）。",
    inputSchema: {
      type: "object",
      properties: { duration: { type: "number", exclusiveMinimum: 0, maximum: 30 } },
      required: ["duration"],
      additionalProperties: false,
    },
    annotations: { title: "Wait", ...READ },
  },
  {
    name: "zoom",
    description:
      "直前の screenshot の矩形 region [x0, y0, x1, y1]（画素）を高い解像度で撮り直す。細かい文字を読むため。座標の基準は変わらない（クリックは元の screenshot の画素で）。",
    inputSchema: {
      type: "object",
      properties: { region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } },
      required: ["region"],
      additionalProperties: false,
    },
    annotations: { title: "Zoom", readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  },
];

const INPUT_TOOLS = new Set(DESKTOP_TOOLS.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name));
INPUT_TOOLS.delete("request_access");
INPUT_TOOLS.delete("open_application");

function ok(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { ...value } };
}

/** A refusal for the model: the code and the sentence first, then everything else. */
export function desktopRefusalResult(tool: string, refusal: DesktopRefusal): CallToolResult {
  return {
    content: [{ type: "text", text: `${tool} failed (${refusal.reason}): ${refusal.error}\n${JSON.stringify(refusal, null, 2)}` }],
    structuredContent: { ...refusal },
    isError: true,
  };
}

const refuse = (reason: string, error: string, extra: Record<string, unknown> = {}): DesktopRefusal => ({ error, reason, ...extra });

interface GrantedApp {
  readonly bundleId: string;
  readonly name: string;
  readonly input: boolean;
}

interface Grant {
  readonly requestId: string;
  readonly apps: readonly GrantedApp[];
  readonly expiresAt: number;
}

class Refused extends Error {
  constructor(readonly refusal: DesktopRefusal) {
    super(refusal.error);
  }
}

function point(v: unknown, name = "coordinate"): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Refused(refuse("bad-request", `${name} must be [x, y]`));
  }
  return [v[0] as number, v[1] as number];
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Refused(refuse("bad-request", `${name} is required`));
  return v;
}

/** The tool logic, without a transport. */
export function createDesktopToolHandler(options: DesktopServerOptions) {
  const { approval, helper, deskId } = options;
  const now = options.now ?? Date.now;
  const sessionId = options.sessionId ?? randomUUID();
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const shot = {
    maxWidth: options.screenshot?.maxWidth ?? DEFAULT_SCREENSHOT_MAX,
    maxHeight: options.screenshot?.maxHeight ?? DEFAULT_SCREENSHOT_MAX,
    format: options.screenshot?.format ?? "jpeg",
    quality: options.screenshot?.quality ?? 0.8,
  };

  let grant: Grant | undefined;
  let aborted = false;
  let expired = false;
  let sessionActive = false;
  let geometry: ScreenGeometry | undefined;
  let pending: { requestId: string; key: string } | undefined;

  const log = (entry: Record<string, unknown>): void => {
    if (!options.logFile) return;
    try {
      fs.appendFileSync(options.logFile, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
    } catch {
      // A log that cannot be written never stops a call.
    }
  };

  function markAborted(by: string): void {
    if (!grant && aborted) return;
    grant = undefined;
    aborted = true;
    sessionActive = false;
    geometry = undefined;
    log({ event: "aborted", by });
  }

  helper.onEvent((e) => {
    if (e.event === "aborted" && (e.session === undefined || e.session === sessionId)) markAborted(e.by ?? "helper");
  });
  helper.onDisconnect(() => {
    sessionActive = false;
  });

  function expire(): void {
    grant = undefined;
    expired = true;
    sessionActive = false;
    geometry = undefined;
    void helper.request("endSession", { session: sessionId });
  }

  /** Throws unless there is a live grant (and, for input, one app that takes input). */
  function guard(kind: "screen" | "input"): Grant {
    if (aborted) throw new Refused(refuse("aborted", "The user stopped the session (Esc). Stop and check with the user before calling request_access again."));
    if (grant && now() >= grant.expiresAt) expire();
    if (!grant) {
      if (expired) throw new Refused(refuse("expired", "The grant has expired. Call request_access again."));
      throw new Refused(refuse("no-access", "No app is granted yet. Call request_access first."));
    }
    if (kind === "input" && !grant.apps.some((a) => a.input)) {
      throw new Refused(refuse("read-only", "The granted apps are screenshot-only (browsers): no clicks or keys.", { apps: grant.apps.map((a) => a.bundleId) }));
    }
    return grant;
  }

  async function beginSession(g: Grant): Promise<void> {
    const r = await helper.request("beginSession", {
      session: sessionId,
      apps: g.apps.map((a) => a.bundleId),
      inputApps: g.apps.filter((a) => a.input).map((a) => a.bundleId),
      expiresAt: g.expiresAt,
    });
    if (!r.ok) throw new Refused(stripOk(r));
    sessionActive = true;
  }

  function stripOk(r: { ok: false } & DesktopRefusal): DesktopRefusal {
    const { ok: _ok, ...rest } = r;
    return rest;
  }

  /** A helper call within the session: begins it if needed, and once more if the helper lost it (restart). */
  async function session<T>(op: string, params: Record<string, unknown>, kind: "screen" | "input", timeoutMs?: number): Promise<T> {
    let g = guard(kind);
    for (let attempt = 0; ; attempt++) {
      if (!sessionActive) await beginSession(g);
      const r: HelperResponse<T> = await helper.request<T>(op, { ...params, session: sessionId }, timeoutMs);
      if (r.ok) return r.result;
      if (r.reason === "aborted") markAborted("helper");
      else if (r.reason === "expired") expire();
      else if (r.reason === "no-session" && attempt === 0) {
        sessionActive = false;
        g = guard(kind);
        continue;
      }
      throw new Refused(stripOk(r));
    }
  }

  function needGeometry(): ScreenGeometry {
    if (!geometry) throw new Refused(refuse("no-screenshot", "Take a screenshot first: coordinates are in its pixels."));
    return geometry;
  }

  function at(v: unknown, name = "coordinate"): { x: number; y: number } {
    const [x, y] = point(v, name);
    try {
      return toPoint(needGeometry(), x, y);
    } catch (e) {
      if (e instanceof Refused) throw e;
      throw new Refused(refuse("bad-request", (e as Error).message));
    }
  }

  function grantView(): Record<string, unknown> {
    if (grant && now() >= grant.expiresAt) expire();
    const status = grant ? "granted" : aborted ? "aborted" : expired ? "expired" : "none";
    return {
      status,
      apps: grant ? grant.apps.map((a) => ({ ...a })) : [],
      ...(grant ? { expiresAt: new Date(grant.expiresAt).toISOString(), requestId: grant.requestId } : {}),
      ...(pending ? { pendingRequestId: pending.requestId } : {}),
    };
  }

  async function requestAccess(args: Record<string, unknown>): Promise<CallToolResult> {
    const { apps } = args;
    if (!Array.isArray(apps) || apps.length === 0 || !apps.every((a) => typeof a === "string" && a.trim() !== "")) {
      throw new Refused(refuse("bad-request", "apps must be a non-empty array of app names or bundle ids"));
    }
    const reason = str(args.reason, "reason");
    const resolved = await helper.request<{ apps: HelperResolvedApp[] }>("resolveApps", { apps });
    if (!resolved.ok) throw new Refused(stripOk(resolved));
    const unknown = resolved.result.apps.filter((a) => !a.bundleId).map((a) => a.query);
    if (unknown.length > 0) {
      throw new Refused(refuse("unknown-app", `No installed app matches: ${unknown.join(", ")}. Use the app's name as in /Applications, or its bundle id.`, { apps: unknown }));
    }
    const seen = new Set<string>();
    const refs: DesktopAppRequest[] = [];
    for (const a of resolved.result.apps) {
      if (seen.has(a.bundleId!)) continue;
      seen.add(a.bundleId!);
      refs.push({ query: a.query, bundleId: a.bundleId, name: a.name, readOnly: isBrowser(a.bundleId!) });
    }
    const key = [...seen].sort().join("\n");

    let state: DesktopAccessState;
    if (pending && pending.key === key) {
      const r = await approval.waitFor(pending.requestId, approvalTimeoutMs);
      if (!r.ok) throw new Refused(r.refusal);
      state = r.value;
    } else {
      const created = await approval.create({ deskId, apps: refs, reason });
      if (!created.ok) throw new Refused(created.refusal);
      state = created.value;
      if (state.status === "pending") {
        pending = { requestId: state.requestId, key };
        const r = await approval.waitFor(state.requestId, approvalTimeoutMs);
        if (!r.ok) throw new Refused(r.refusal);
        state = r.value;
      }
    }
    log({ event: "access", requestId: state.requestId, status: state.status, apps: [...seen] });

    if (state.status === "pending") {
      pending = { requestId: state.requestId, key };
      return ok({
        status: "pending",
        requestId: state.requestId,
        message: "The person has not answered yet. Call request_access again with the same apps to keep waiting.",
      });
    }
    pending = undefined;
    if (state.status !== "granted") {
      throw new Refused(refuse(state.status, state.message ?? `The request was ${state.status}.`, { requestId: state.requestId }));
    }

    // Only what was asked; browsers and readOnly ones never take input.
    const readOnly = new Set(state.readOnly ?? []);
    const granted: GrantedApp[] = refs
      .filter((r) => state.apps!.includes(r.bundleId!))
      .map((r) => ({ bundleId: r.bundleId!, name: r.name ?? r.bundleId!, input: !r.readOnly && !readOnly.has(r.bundleId!) }));
    const expiresAt = Date.parse(state.expiresAt!);
    if (granted.length === 0) throw new Refused(refuse("denied", "None of the apps asked for was granted.", { requestId: state.requestId }));
    if (expiresAt <= now()) throw new Refused(refuse("expired", "The grant had already expired.", { requestId: state.requestId }));

    grant = { requestId: state.requestId, apps: granted, expiresAt };
    aborted = false;
    expired = false;
    sessionActive = false;
    geometry = undefined;
    await beginSession(grant);
    return ok({ ...grantView(), ...(state.message ? { message: state.message } : {}) });
  }

  function image(s: HelperScreenshot, note: Record<string, unknown>): CallToolResult {
    return {
      content: [
        { type: "image", data: s.data, mimeType: s.mimeType },
        { type: "text", text: JSON.stringify(note) },
      ],
    };
  }

  async function screenshot(): Promise<CallToolResult> {
    const g = guard("screen");
    const s = await session<HelperScreenshot>("screenshot", shot, "screen");
    geometry = { width: s.width, height: s.height, originX: s.originX, originY: s.originY, pointWidth: s.pointWidth, pointHeight: s.pointHeight };
    const captured = new Set(s.apps);
    const notVisible = g.apps.filter((a) => !captured.has(a.bundleId)).map((a) => a.bundleId);
    return image(s, { width: s.width, height: s.height, apps: s.apps, ...(notVisible.length ? { notVisible } : {}) });
  }

  async function click(args: Record<string, unknown>, button: "left" | "right" | "middle", count: number) {
    const p = at(args.coordinate);
    const modifiers = typeof args.text === "string" && args.text.trim() !== "" ? args.text.split(/[+\s]+/).filter(Boolean) : [];
    return session<Record<string, unknown>>("click", { ...p, button, count, modifiers }, "input");
  }

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // The grant before the arguments: an aborted or expired session says so, not "take a screenshot".
    if (INPUT_TOOLS.has(name)) guard("input");
    switch (name) {
      case "request_access":
        return requestAccess(args);
      case "list_granted_applications":
        return ok(grantView());
      case "screenshot":
        return screenshot();
      case "left_click":
        return ok(await click(args, "left", 1));
      case "right_click":
        return ok(await click(args, "right", 1));
      case "middle_click":
        return ok(await click(args, "middle", 1));
      case "double_click":
        return ok(await click(args, "left", 2));
      case "triple_click":
        return ok(await click(args, "left", 3));
      case "mouse_move":
        return ok(await session("move", at(args.coordinate), "input"));
      case "left_click_drag": {
        const from = at(args.start_coordinate, "start_coordinate");
        const to = at(args.coordinate);
        return ok(await session("drag", { ...from, toX: to.x, toY: to.y, button: "left" }, "input"));
      }
      case "left_mouse_down":
      case "left_mouse_up": {
        const p = args.coordinate === undefined ? {} : at(args.coordinate);
        return ok(await session(name === "left_mouse_down" ? "mouseDown" : "mouseUp", { ...p, button: "left" }, "input"));
      }
      case "scroll": {
        const p = at(args.coordinate);
        const dir = args.scroll_direction;
        if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
          throw new Refused(refuse("bad-request", "scroll_direction must be up / down / left / right"));
        }
        const amount = args.scroll_amount === undefined ? 3 : Number(args.scroll_amount);
        if (!Number.isInteger(amount) || amount < 1 || amount > 50) throw new Refused(refuse("bad-request", "scroll_amount must be an integer 1-50"));
        const dy = dir === "up" ? amount : dir === "down" ? -amount : 0;
        const dx = dir === "left" ? amount : dir === "right" ? -amount : 0;
        return ok(await session("scroll", { ...p, dx, dy }, "input"));
      }
      case "key":
        return ok(await session("key", { keys: str(args.text, "text") }, "input"));
      case "type": {
        if (typeof args.text !== "string" || args.text === "") throw new Refused(refuse("bad-request", "text is required"));
        const text = args.text;
        return ok(await session("type", { text }, "input", 30_000 + text.length * 50));
      }
      case "open_application": {
        const q = str(args.app, "app").trim().toLowerCase();
        const g = guard("screen");
        const app = g.apps.find((a) => a.bundleId.toLowerCase() === q || a.name.toLowerCase() === q);
        if (!app) throw new Refused(refuse("not-allowed", `${args.app as string} is not granted. Call request_access for it first.`));
        return ok(await session("openApp", { bundleId: app.bundleId }, "screen"));
      }
      case "cursor_position": {
        const p = await session<{ x: number; y: number }>("cursor", {}, "screen");
        return ok(geometry ? toPixel(geometry, p.x, p.y) : { ...p, unit: "points (take a screenshot for pixels)" });
      }
      case "wait": {
        const d = Number(args.duration);
        if (!Number.isFinite(d) || d <= 0 || d > 30) throw new Refused(refuse("bad-request", "duration must be 0-30 seconds"));
        await new Promise((r) => setTimeout(r, d * 1000));
        return ok({ waited: d });
      }
      case "zoom": {
        guard("screen");
        let region;
        try {
          region = toPointRect(needGeometry(), Array.isArray(args.region) ? (args.region as number[]) : []);
        } catch (e) {
          if (e instanceof Refused) throw e;
          throw new Refused(refuse("bad-request", (e as Error).message));
        }
        const s = await session<HelperScreenshot>("screenshot", { ...shot, region }, "screen");
        return image(s, { width: s.width, height: s.height, region: args.region, note: "Coordinates stay in the last screenshot's pixels." });
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool "${name}"` }], isError: true };
    }
  }

  return {
    tools: DESKTOP_TOOLS,
    log,
    sessionId,
    async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      // What is logged: the tool, the outcome, and sizes; never an image or typed text.
      const extra = name === "type" && typeof args.text === "string" ? { length: args.text.length } : {};
      try {
        const r = await call(name, args);
        log({ event: "tools/call", tool: name, isError: r.isError === true, ...extra });
        return r;
      } catch (e) {
        if (e instanceof Refused) {
          log({ event: "tools/call", tool: name, isError: true, reason: e.refusal.reason, ...extra });
          return desktopRefusalResult(name, e.refusal);
        }
        log({ event: "tools/call", tool: name, isError: true, thrown: e instanceof Error ? e.message : String(e) });
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  };
}

export function createDesktopMcpServer(options: DesktopServerOptions): DesktopServerHandle {
  const handler = createDesktopToolHandler(options);
  const server = new Server(
    { name: DESKTOP_SERVER_NAME, version: DESKTOP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: DESKTOP_INSTRUCTIONS },
  );
  server.oninitialized = () => handler.log({ event: "initialized", client: server.getClientVersion(), cwd: process.cwd() });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...handler.tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const raw = req.params.arguments;
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return handler.call(req.params.name, args);
  });

  let transport: StdioServerTransport | undefined;
  return {
    server,
    instructions: DESKTOP_INSTRUCTIONS,
    async start() {
      transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async stop() {
      await server.close();
      options.helper.close();
      transport = undefined;
    },
  };
}
