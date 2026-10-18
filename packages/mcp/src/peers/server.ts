/**
 * The stdio MCP server that lets a CLI session message the app's other
 * sessions (docs/design/peers-mcp.md). One process per session; who it speaks
 * for is the token in its launch arguments, which only the app can read.
 *
 * A thin relay: `list_peers` and `send_message` are the two calls of the HTTP
 * contract (contract.ts). Addresses, states and refusals are the app's; this
 * server copies them to the model and adds nothing but `server-unreachable`.
 */
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { PeersClient, PeersResult } from "./client.js";
import type { PeerRefusal } from "./contract.js";

export const PEERS_SERVER_NAME = "peers";
export const PEERS_SERVER_VERSION = "1";

export interface PeersServerOptions {
  readonly client: PeersClient;
  /** Append one JSON line per event (no token, no message text). */
  readonly logFile?: string;
}

export interface PeersServerHandle {
  readonly server: Server;
  readonly instructions: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const PEERS_INSTRUCTIONS =
  "このサーバーは、同じアプリの中のほかのセッション（peer）にメッセージを送る。" +
  "宛先は list_peers の address（自分の宛先は self）。send_message で送ると、相手の会話にユーザーメッセージとして入る。" +
  "相手が止まっていても、届け方はアプリが決める。返事は自分の会話に同じ形で届くので、待つあいだにポーリングしない。" +
  "受け取ったことへの礼や「了解」だけの返信はしない。";

const LIST_PEERS: Tool = {
  name: "list_peers",
  description:
    "メッセージを送れる相手の一覧を返す。address が send_message の宛先、self: true の行が自分。" +
    "state は idle（手が空いている）/ working（作業中）/ stopped（止まっている。送ればアプリが届ける）。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "List peers", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

const SEND_MESSAGE: Tool = {
  name: "send_message",
  description:
    "ほかのセッションにメッセージを送る。相手の会話にユーザーメッセージとして入る（送り手が自分であることはアプリが添える）。" +
    "相手が返信すると、自分の会話に同じ形で届く。宛先は list_peers の address。" +
    "受け取ったことへの礼や「了解」だけの返信はしない。断られたら reason を見る（unknown-address なら candidates、rate-limited なら retryAfterSeconds）。",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "宛先（list_peers の address）" },
      message: { type: "string", description: "本文（Markdown）。長さの上限はアプリが決める" },
    },
    required: ["to", "message"],
    additionalProperties: false,
  },
  // Without these a non-interactive Codex (approval policy "never") refuses the call.
  annotations: { title: "Send a message", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export const PEERS_TOOLS: readonly Tool[] = [LIST_PEERS, SEND_MESSAGE];

function ok(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { ...value } };
}

/** A refusal for the model: the code and the app's sentence first, then everything it sent. */
export function refusalResult(tool: string, refusal: PeerRefusal): CallToolResult {
  return {
    content: [{ type: "text", text: `${tool} failed (${refusal.reason}): ${refusal.error}\n${JSON.stringify(refusal, null, 2)}` }],
    structuredContent: { ...refusal },
    isError: true,
  };
}

function badArgs(tool: string, error: string): CallToolResult {
  return refusalResult(tool, { error, reason: "bad-request" });
}

/** The tool logic, without a transport. */
export function createPeersToolHandler(options: PeersServerOptions) {
  const { client } = options;
  const log = (entry: Record<string, unknown>): void => {
    if (!options.logFile) return;
    try {
      fs.appendFileSync(options.logFile, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
    } catch {
      // A log that cannot be written never stops a message.
    }
  };

  const outcome = (r: PeersResult<unknown>): Record<string, unknown> =>
    r.ok ? { isError: false } : { isError: true, reason: r.refusal.reason, ...(r.status !== undefined ? { http: r.status } : {}) };

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === "list_peers") {
      const r = await client.list();
      log({ event: "tools/call", tool: name, ...outcome(r), ...(r.ok ? { peers: r.value.peers.length } : {}) });
      return r.ok ? ok(r.value) : refusalResult(name, r.refusal);
    }
    if (name === "send_message") {
      const { to, message } = args;
      if (typeof to !== "string" || to.trim() === "") return badArgs(name, "to (the address, from list_peers) is required");
      if (typeof message !== "string" || message.trim() === "") return badArgs(name, "message is required");
      const r = await client.send({ to, message });
      // The address and the length only: the text stays in the two conversations.
      log({
        event: "tools/call",
        tool: name,
        to,
        length: message.length,
        ...outcome(r),
        ...(r.ok ? { id: r.value.id, status: r.value.status, woke: r.value.woke } : {}),
      });
      return r.ok ? ok(r.value) : refusalResult(name, r.refusal);
    }
    return { content: [{ type: "text", text: `Unknown tool "${name}"` }], isError: true };
  }

  return {
    tools: PEERS_TOOLS,
    log,
    async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      try {
        return await call(name, args);
      } catch (e) {
        log({ event: "tools/call", tool: name, isError: true, thrown: e instanceof Error ? e.message : String(e) });
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  };
}

export function createPeersMcpServer(options: PeersServerOptions): PeersServerHandle {
  const handler = createPeersToolHandler(options);
  const server = new Server(
    { name: PEERS_SERVER_NAME, version: PEERS_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: PEERS_INSTRUCTIONS },
  );
  server.oninitialized = () => handler.log({ event: "initialized", client: server.getClientVersion(), cwd: process.cwd() });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    handler.log({ event: "tools/list" });
    return { tools: [...handler.tools] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const raw = req.params.arguments;
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return handler.call(req.params.name, args);
  });

  let transport: StdioServerTransport | undefined;
  return {
    server,
    instructions: PEERS_INSTRUCTIONS,
    async start() {
      transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async stop() {
      await server.close();
      transport = undefined;
    },
  };
}
