/**
 * The client of the native helper's Unix socket (JSON lines, contract.ts).
 *
 * One connection per MCP server, opened on first use. The helper releases
 * the session lock when the connection closes, so a dropped connection means
 * the session must be begun again (`onDisconnect`). When the socket is
 * missing or dead, the helper is started once (`open -g -a <app>`) and the
 * connection retried until `connectTimeoutMs`.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HELPER_SOCKET_SUFFIX, HELPER_BUNDLE_ID, type HelperEvent, type HelperResponse } from "./contract.js";

export interface HelperClientOptions {
  /** Default `~/Library/Application Support/synapse-desktop/helper.sock`. */
  readonly socketPath?: string;
  /** Starts the helper. Default: `open -g -a <helperApp>` (or `open -g -b <bundle id>`). */
  readonly launch?: () => Promise<void>;
  /** The .app to start. Default: this package's `desktop-helper/build/SynapseDesktopHelper.app` if built, else by bundle id. */
  readonly helperApp?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface HelperClient {
  request<T>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<HelperResponse<T>>;
  onEvent(listener: (e: HelperEvent) => void): void;
  onDisconnect(listener: () => void): void;
  close(): void;
}

export function defaultHelperSocket(): string {
  return path.join(os.homedir(), DEFAULT_HELPER_SOCKET_SUFFIX);
}

/** The helper built in this checkout (`desktop-helper/build.sh`), if there is one. */
export function defaultHelperApp(): string | undefined {
  const p = fileURLToPath(new URL("../../desktop-helper/build/SynapseDesktopHelper.app", import.meta.url));
  return fs.existsSync(p) ? p : undefined;
}

function openHelper(app: string | undefined, socketPath: string): Promise<void> {
  const args = app ? ["-g", "-a", app] : ["-g", "-b", HELPER_BUNDLE_ID];
  if (socketPath !== defaultHelperSocket()) args.push("--args", "--socket", socketPath);
  return new Promise((resolve, reject) => {
    execFile("open", args, (err) => (err ? reject(err) : resolve()));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createHelperClient(options: HelperClientOptions = {}): HelperClient {
  const socketPath = options.socketPath ?? defaultHelperSocket();
  const launch = options.launch ?? (() => openHelper(options.helperApp ?? defaultHelperApp(), socketPath));
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;

  let socket: net.Socket | undefined;
  let connecting: Promise<net.Socket> | undefined;
  let nextId = 1;
  let buffer = "";
  let closed = false;
  const pending = new Map<number, { resolve: (r: HelperResponse<unknown>) => void; timer: NodeJS.Timeout }>();
  const eventListeners: ((e: HelperEvent) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];

  const tryConnect = () =>
    new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(socketPath);
      s.once("connect", () => {
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", reject);
    });

  function attach(s: net.Socket): void {
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof msg.event === "string") {
          for (const l of eventListeners) l(msg as unknown as HelperEvent);
          continue;
        }
        const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
        if (!p) continue;
        pending.delete(msg.id as number);
        clearTimeout(p.timer);
        const { id: _id, ...rest } = msg;
        p.resolve(rest as unknown as HelperResponse<unknown>);
      }
    });
    const gone = () => {
      if (socket !== s) return;
      socket = undefined;
      buffer = "";
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, reason: "helper-unavailable", error: "The desktop helper closed the connection." });
        pending.delete(id);
      }
      for (const l of disconnectListeners) l();
    };
    s.on("close", gone);
    s.on("error", () => s.destroy());
  }

  async function connect(): Promise<net.Socket> {
    if (socket) return socket;
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        return await tryConnect();
      } catch {
        // Missing or dead socket: start the helper once, then wait for it.
      }
      try {
        await launch();
      } catch (e) {
        throw new Error(`could not start the desktop helper: ${e instanceof Error ? e.message : String(e)}`);
      }
      const deadline = Date.now() + connectTimeoutMs;
      let last: unknown;
      while (Date.now() < deadline) {
        try {
          return await tryConnect();
        } catch (e) {
          last = e;
          await sleep(200);
        }
      }
      throw new Error(`the desktop helper did not open ${socketPath} in ${connectTimeoutMs} ms (${(last as NodeJS.ErrnoException)?.code ?? last})`);
    })();
    try {
      const s = await connecting;
      if (closed) {
        s.destroy();
        throw new Error("closed");
      }
      socket = s;
      attach(s);
      return s;
    } finally {
      connecting = undefined;
    }
  }

  return {
    async request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = requestTimeoutMs): Promise<HelperResponse<T>> {
      let s: net.Socket;
      try {
        s = await connect();
      } catch (e) {
        return { ok: false, reason: "helper-unavailable", error: e instanceof Error ? e.message : String(e) };
      }
      const id = nextId++;
      return new Promise<HelperResponse<T>>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, reason: "helper-unavailable", error: `The desktop helper did not answer ${op} in ${timeoutMs} ms.`, detail: "timeout" });
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (r: HelperResponse<unknown>) => void, timer });
        s.write(JSON.stringify({ ...params, id, op }) + "\n");
      });
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onDisconnect(listener) {
      disconnectListeners.push(listener);
    },
    close() {
      closed = true;
      socket?.destroy();
    },
  };
}
