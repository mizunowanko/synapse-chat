/**
 * The HTTP side of the peers MCP server: the two calls of the contract
 * (contract.ts), with every failure turned into a {@link PeerRefusal}.
 *
 * `node:http` / `node:https`, not `fetch`: the request must carry exactly the
 * headers the contract names. The app refuses any request with `Origin`, and
 * what a `fetch` implementation adds on its own is not ours to decide.
 */
import http from "node:http";
import https from "node:https";
import {
  PEERS_LIST_PATH,
  PEERS_MESSAGES_PATH,
  SERVER_UNREACHABLE,
  type PeerRefusal,
  type PeersListResponse,
  type SendPeerMessageRequest,
  type SendPeerMessageResponse,
} from "./contract.js";

/** Below Codex's default MCP tool timeout (60 s), so the model gets our answer rather than the CLI's. */
export const DEFAULT_PEERS_TIMEOUT_MS = 45_000;

export interface PeersClientOptions {
  /** The app's base URL (`http://127.0.0.1:8001`). The contract's paths are appended. */
  readonly api: string;
  /** The bearer token that names this session to the app. */
  readonly token: string;
  readonly timeoutMs?: number;
}

export type PeersResult<T> = { ok: true; value: T } | { ok: false; refusal: PeerRefusal; status?: number };

export interface PeersClient {
  list(): Promise<PeersResult<PeersListResponse>>;
  send(request: SendPeerMessageRequest): Promise<PeersResult<SendPeerMessageResponse>>;
}

/** Throws unless `api` is an absolute http(s) URL with no query or fragment. */
export function assertPeersApiUrl(api: string): URL {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new Error(`peers api must be an absolute http(s) URL: ${api}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`peers api must be http(s): ${api}`);
  if (url.search || url.hash) throw new Error(`peers api must not carry a query or fragment: ${api}`);
  return url;
}

/** Throws unless `token` is a non-empty header-safe value (it goes into `Authorization`). */
export function assertPeersToken(token: string): void {
  if (token === "" || !/^[\x21-\x7e]+$/.test(token)) throw new Error("peers token must be non-empty printable ASCII without spaces");
}

function endpoint(base: URL, path: string): URL {
  const url = new URL(base.href);
  url.pathname = url.pathname.replace(/\/+$/, "") + path;
  return url;
}

interface RawResponse {
  status: number;
  body: string;
}

function request(url: URL, method: "GET" | "POST", token: string, body: string | undefined, timeoutMs: number): Promise<RawResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    // The whole exchange, not socket idleness.
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new TimeoutError(timeoutMs)));
      req.destroy();
    }, timeoutMs);
    const fail = (e: unknown): void => settle(() => reject(e));
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => settle(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", fail);
    });
    req.on("error", fail);
    req.end(body);
  });
}

class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`no answer in ${ms} ms`);
  }
}

function unreachable(error: string, detail: string): PeerRefusal {
  return { error, reason: SERVER_UNREACHABLE, detail };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isListResponse(v: unknown): v is PeersListResponse {
  return isObject(v) && typeof v.self === "string" && Array.isArray(v.peers);
}

function isSendResponse(v: unknown): v is SendPeerMessageResponse {
  return isObject(v) && typeof v.id === "string" && typeof v.to === "string" && typeof v.status === "string";
}

async function call<T>(
  url: URL,
  method: "GET" | "POST",
  token: string,
  body: string | undefined,
  timeoutMs: number,
  accept: (v: unknown) => v is T,
): Promise<PeersResult<T>> {
  let res: RawResponse;
  try {
    res = await request(url, method, token, body, timeoutMs);
  } catch (e) {
    if (e instanceof TimeoutError) {
      // A POST may have gone through: say so, so the model does not blindly resend.
      return {
        ok: false,
        refusal: unreachable(
          method === "POST"
            ? `The app did not answer in ${Math.round(timeoutMs / 1000)} s. The message may or may not have been delivered; check before sending it again.`
            : `The app did not answer in ${Math.round(timeoutMs / 1000)} s.`,
          "timeout",
        ),
      };
    }
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ok: false,
      refusal: unreachable(`Cannot reach the app at ${url.origin} (${code ?? (e instanceof Error ? e.message : String(e))}).`, code ?? "connection-failed"),
    };
  }
  const parsed = parseJson(res.body);
  if (res.status >= 200 && res.status < 300) {
    if (accept(parsed)) return { ok: true, value: parsed };
    return { ok: false, status: res.status, refusal: unreachable(`The app answered HTTP ${res.status} in an unexpected shape.`, `bad-response: HTTP ${res.status}`) };
  }
  if (isObject(parsed) && typeof parsed.reason === "string" && parsed.reason !== "") {
    const error = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    return { ok: false, status: res.status, refusal: { ...parsed, error, reason: parsed.reason } };
  }
  return { ok: false, status: res.status, refusal: unreachable(`The app answered HTTP ${res.status} without a reason.`, `bad-response: HTTP ${res.status}`) };
}

export function createPeersClient(options: PeersClientOptions): PeersClient {
  const base = assertPeersApiUrl(options.api);
  assertPeersToken(options.token);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PEERS_TIMEOUT_MS;
  const listUrl = endpoint(base, PEERS_LIST_PATH);
  const sendUrl = endpoint(base, PEERS_MESSAGES_PATH);
  return {
    list: () => call(listUrl, "GET", options.token, undefined, timeoutMs, isListResponse),
    send: (req) =>
      call(sendUrl, "POST", options.token, JSON.stringify({ to: req.to, message: req.message }), timeoutMs, isSendResponse),
  };
}
