/**
 * The client of the approval API (contract.ts): ask, then wait for a person.
 *
 * `node:http` / `node:https`, not `fetch`, for the same reason as the peers
 * client: the request carries exactly the headers the contract names, and
 * never `Origin`.
 */
import http from "node:http";
import https from "node:https";
import {
  DESKTOP_ACCESS_PATH,
  type DesktopAccessRequest,
  type DesktopAccessState,
  type DesktopRefusal,
} from "./contract.js";

/** How long one `request_access` call waits for the person before answering `pending`. Below Codex's 60 s tool timeout. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 45_000;
/** The longest single GET (the app may answer sooner). */
const POLL_WAIT_MS = 20_000;
/** Between GETs when the app answers `pending` at once (no long poll). */
const POLL_INTERVAL_MS = 1_000;

export interface ApprovalClientOptions {
  /** The app's base URL (`http://127.0.0.1:8001`). */
  readonly api: string;
  /** Sent as `Authorization: Bearer` when given. */
  readonly token?: string;
}

export type ApprovalResult<T> = { ok: true; value: T } | { ok: false; refusal: DesktopRefusal; status?: number };

export interface ApprovalClient {
  create(request: DesktopAccessRequest): Promise<ApprovalResult<DesktopAccessState>>;
  get(requestId: string, waitMs: number): Promise<ApprovalResult<DesktopAccessState>>;
  /** GET until the state is not `pending` or `timeoutMs` has passed (then the last `pending`). */
  waitFor(requestId: string, timeoutMs: number): Promise<ApprovalResult<DesktopAccessState>>;
}

/** Throws unless `api` is an absolute http(s) URL with no query or fragment. */
export function assertDesktopApiUrl(api: string): URL {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new Error(`desktop api must be an absolute http(s) URL: ${api}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`desktop api must be http(s): ${api}`);
  if (url.search || url.hash) throw new Error(`desktop api must not carry a query or fragment: ${api}`);
  return url;
}

/** Throws unless `value` is non-empty printable ASCII without spaces (header- and argv-safe). */
export function assertDesktopToken(value: string, what = "token"): void {
  if (value === "" || !/^[\x21-\x7e]+$/.test(value)) throw new Error(`desktop ${what} must be non-empty printable ASCII without spaces`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATUSES = new Set(["pending", "granted", "denied", "expired"]);

function isState(v: unknown): v is DesktopAccessState {
  if (!isObject(v) || typeof v.requestId !== "string" || v.requestId === "" || typeof v.status !== "string" || !STATUSES.has(v.status)) {
    return false;
  }
  if (v.status !== "granted") return true;
  const strings = (a: unknown) => Array.isArray(a) && a.every((s) => typeof s === "string");
  return strings(v.apps) && (v.readOnly === undefined || strings(v.readOnly)) && typeof v.expiresAt === "string" && !Number.isNaN(Date.parse(v.expiresAt));
}

function unreachable(error: string, detail: string): DesktopRefusal {
  return { error, reason: "server-unreachable", detail };
}

function send(url: URL, method: "GET" | "POST", token: string | undefined, body: string | undefined, timeoutMs: number) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  const lib = url.protocol === "https:" ? https : http;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })));
      req.destroy();
    }, timeoutMs);
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => settle(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", (e) => settle(() => reject(e)));
    });
    req.on("error", (e) => settle(() => reject(e)));
    req.end(body);
  });
}

async function call(url: URL, method: "GET" | "POST", token: string | undefined, body: string | undefined, timeoutMs: number) {
  let res: { status: number; body: string };
  try {
    res = await send(url, method, token, body, timeoutMs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, refusal: unreachable(`Cannot reach the app at ${url.origin} (${code}).`, code) } as const;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = undefined;
  }
  if (res.status >= 200 && res.status < 300) {
    if (isState(parsed)) return { ok: true, value: parsed } as const;
    return { ok: false, status: res.status, refusal: unreachable(`The app answered HTTP ${res.status} in an unexpected shape.`, `bad-response: HTTP ${res.status}`) } as const;
  }
  if (isObject(parsed) && typeof parsed.reason === "string" && parsed.reason !== "") {
    const error = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    return { ok: false, status: res.status, refusal: { ...parsed, error, reason: parsed.reason } } as const;
  }
  return { ok: false, status: res.status, refusal: unreachable(`The app answered HTTP ${res.status} without a reason.`, `bad-response: HTTP ${res.status}`) } as const;
}

function endpoint(base: URL, path: string, query?: Record<string, string>): URL {
  const url = new URL(base.href);
  url.pathname = url.pathname.replace(/\/+$/, "") + path;
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url;
}

export function createApprovalClient(options: ApprovalClientOptions & { pollIntervalMs?: number }): ApprovalClient {
  const base = assertDesktopApiUrl(options.api);
  if (options.token !== undefined) assertDesktopToken(options.token);
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const client: ApprovalClient = {
    create: (req) =>
      call(endpoint(base, DESKTOP_ACCESS_PATH), "POST", options.token, JSON.stringify({ deskId: req.deskId, apps: req.apps, reason: req.reason }), 15_000),
    get: (requestId, waitMs) =>
      call(
        endpoint(base, `${DESKTOP_ACCESS_PATH}/${encodeURIComponent(requestId)}`, { waitMs: String(Math.max(0, Math.round(waitMs))) }),
        "GET",
        options.token,
        undefined,
        waitMs + 10_000,
      ),
    async waitFor(requestId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const left = deadline - Date.now();
        const started = Date.now();
        const r = await client.get(requestId, Math.max(0, Math.min(POLL_WAIT_MS, left)));
        if (!r.ok || r.value.status !== "pending" || Date.now() >= deadline) return r;
        // An app without long poll answers at once: do not spin.
        const spent = Date.now() - started;
        if (spent < interval) await new Promise((res) => setTimeout(res, Math.min(interval - spent, Math.max(0, deadline - Date.now()))));
        if (Date.now() >= deadline) return r;
      }
    },
  };
  return client;
}
