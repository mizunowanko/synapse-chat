/**
 * The stdio MCP server that hands skills to a CLI session
 * (docs/design/skills-mcp.md). One process per session; it learns who it is
 * serving from its launch arguments and never changes its mind.
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
import { materializeSkill } from "./materialize.js";
import {
  agentScope,
  deskScope,
  describeScope,
  mcpWriteRefusal,
  type SkillScope,
} from "./scope.js";
import type { SkillFile, SkillRecord, SkillStore } from "./store.js";

export const SKILLS_SERVER_NAME = "skills";
export const SKILLS_SERVER_VERSION = "1";

export interface SkillsServerOptions {
  readonly store: SkillStore;
  /** Who this session is. `{ agent: "", desk: "" }` sees only the everyone tier and cannot write. */
  readonly viewer: SkillScope;
  /** Where `get_skill` writes attached files. */
  readonly cacheRoot: string;
  /** `false` hides `put_skill`. Default `true` (it is still refused without an agent). */
  readonly writable?: boolean;
  /** Append one JSON line per tool call. For measuring whether skills fire. */
  readonly logFile?: string;
}

export interface SkillsServerHandle {
  readonly server: Server;
  /** The instructions sent at `initialize`, fixed at construction. */
  readonly instructions: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The instructions: what the server is for, then every skill the viewer sees. */
export function buildSkillsInstructions(skills: readonly Pick<SkillRecord, "name" | "description">[]): string {
  const head =
    "このサーバーはスキル（作業手順書）を配る。頼まれた仕事が下の一覧のどれかに当てはまるなら、" +
    "作業を始める前に get_skill でそのスキルを取得し、書かれた手順に従うこと。" +
    "スキルの名前をユーザーが言わなくても、仕事の内容で判断する。";
  if (skills.length === 0) return `${head}\n\nいま使えるスキルは無い。`;
  return [head, "", ...skills.map((s) => `- ${s.name}: ${oneLine(s.description)}`)].join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const LIST_SKILLS: Tool = {
  name: "list_skills",
  description: "使えるスキルの名前と説明の一覧を返す。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: READ_ONLY,
};

const GET_SKILL: Tool = {
  name: "get_skill",
  description:
    "スキルの手順書（本文）を返す。付属ファイル（スクリプト等）があればローカルに書き出し、その絶対パスも返す。",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "スキル名" } },
    required: ["name"],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

const PUT_SKILL: Tool = {
  name: "put_skill",
  description:
    "自分のスキルを新しく作るか、新しい版で書き換える。書けるのは自分のエージェントの階層（既定）か、自分の Desk の階層だけ。" +
    "同じ名前のスキルが上の階層にあれば、自分にだけはこちらが見えるようになる。" +
    "description と files を省くと、いま見えている同名スキルのものを引き継ぐ。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "スキル名（英数字で始まり、英数字と . _ - だけ）" },
      description: { type: "string", description: "いつ使うスキルか（一覧に出る）。新しいスキルでは必須" },
      body: { type: "string", description: "手順書の本文（Markdown。frontmatter は付けない）" },
      scope: { type: "string", enum: ["agent", "desk"], description: "書き込む階層。既定は agent" },
      files: {
        type: "array",
        description: "付属ファイル。渡すとそれで置き換える（[] で全部外す）",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "スキルのディレクトリからの相対パス（例: scripts/run.py）" },
            content: { type: "string", description: "中身（UTF-8 のテキスト）" },
            executable: { type: "boolean", description: "実行ビットを立てるか" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    required: ["name", "body"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function text(t: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

/**
 * The tool logic, without a transport. Exposed for tests and for callers that
 * embed the skills in their own MCP server.
 */
export function createSkillsToolHandler(options: SkillsServerOptions) {
  const { store, viewer, cacheRoot } = options;
  const writable = (options.writable ?? true) && viewer.agent !== "";
  const tools = writable ? [LIST_SKILLS, GET_SKILL, PUT_SKILL] : [LIST_SKILLS, GET_SKILL];

  function call(name: string, args: Record<string, unknown>): CallToolResult {
    if (name === "list_skills") {
      const skills = store.list(viewer);
      if (skills.length === 0) return text("いま使えるスキルは無い。");
      return text(
        skills
          .map((s) => `- ${s.name} (v${s.version}・${describeScope(s.scope)}): ${oneLine(s.description)}`)
          .join("\n"),
      );
    }

    if (name === "get_skill") {
      const skillName = args.name;
      if (typeof skillName !== "string") return text("name が要る", true);
      const rec = store.resolve(viewer, skillName);
      if (!rec) return text(`スキル ${skillName} は無い。list_skills で一覧を見ること`, true);
      const m = materializeSkill(cacheRoot, rec.name, rec.version, store.files(rec));
      let out = `# skill: ${rec.name} (v${rec.version})\n\n`;
      if (m.dir) {
        out += `このスキルのディレクトリ: ${m.dir}\n付属ファイル（手順書に出てくる相対パスは、このディレクトリからのもの）:\n`;
        out += m.files.map((f) => `- ${f}`).join("\n") + "\n\n";
      }
      return text(out + rec.body);
    }

    if (name === "put_skill" && writable) {
      const { name: skillName, description, body, scope, files } = args;
      if (typeof skillName !== "string" || typeof body !== "string") return text("name と body が要る", true);
      if (description !== undefined && typeof description !== "string") return text("description は文字列", true);
      if (scope !== undefined && scope !== "agent" && scope !== "desk") return text("scope は agent か desk", true);
      if (scope === "desk" && viewer.desk === "") {
        return text("このセッションには Desk が指定されていない（サーバーの起動引数 --desk）", true);
      }
      // The session can only name its own tiers here, so the rule below cannot
      // refuse today — it is still the one place the rule lives (scope.ts).
      const target = scope === "desk" ? deskScope(viewer.agent, viewer.desk) : agentScope(viewer.agent);
      const refusal = mcpWriteRefusal(viewer, target);
      if (refusal) return text(refusal, true);

      let parsedFiles: SkillFile[] | undefined;
      if (files !== undefined) {
        if (!Array.isArray(files)) return text("files は配列", true);
        parsedFiles = [];
        for (const f of files as unknown[]) {
          const o = f as { path?: unknown; content?: unknown; executable?: unknown };
          if (typeof o?.path !== "string" || typeof o.content !== "string") {
            return text("files の各要素には path と content（文字列）が要る", true);
          }
          parsedFiles.push({
            path: o.path,
            mode: o.executable === true ? 0o755 : 0o644,
            content: new TextEncoder().encode(o.content),
          });
        }
      }

      const input: Parameters<SkillStore["put"]>[1] = {
        name: skillName,
        body,
        author: `mcp:${viewer.agent}${viewer.desk ? `/${viewer.desk}` : ""}`,
        ...(description !== undefined ? { description } : {}),
        ...(parsedFiles !== undefined ? { files: parsedFiles } : {}),
      };
      const { record, changed } = store.put(target, input);
      return text(
        changed
          ? `${record.name} を v${record.version} として ${describeScope(record.scope)} の階層に書いた。`
          : `${record.name} は v${record.version} と同じ中身なので、新しい版は作らなかった。`,
      );
    }

    return text(`Unknown tool "${name}"`, true);
  }

  return {
    tools,
    call(name: string, args: Record<string, unknown>): CallToolResult {
      let result: CallToolResult;
      try {
        result = call(name, args);
      } catch (e) {
        result = text(e instanceof Error ? e.message : String(e), true);
      }
      if (options.logFile) {
        fs.appendFileSync(
          options.logFile,
          JSON.stringify({ t: new Date().toISOString(), pid: process.pid, tool: name, args, isError: result.isError === true, viewer }) + "\n",
        );
      }
      return result;
    },
  };
}

export function createSkillsMcpServer(options: SkillsServerOptions): SkillsServerHandle {
  const instructions = buildSkillsInstructions(options.store.list(options.viewer));
  const handler = createSkillsToolHandler(options);
  const server = new Server(
    { name: SKILLS_SERVER_NAME, version: SKILLS_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: handler.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const raw = req.params.arguments;
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return handler.call(req.params.name, args);
  });

  let transport: StdioServerTransport | undefined;
  return {
    server,
    instructions,
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
