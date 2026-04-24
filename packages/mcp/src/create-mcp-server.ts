import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  augmentSchemaForConfirmation,
  checkConfirmation,
  stripConfirmation,
} from "./confirmation.js";
import { callHttpTool, type FetchLike } from "./http-client.js";
import type {
  HttpToolDefinition,
  ToolArgs,
  ToolResult,
} from "./types.js";

/** Options passed to {@link createMcpServer}. */
export interface CreateMcpServerOptions {
  /** MCP server name advertised over the protocol. */
  readonly name: string;

  /** Server version advertised over the protocol. */
  readonly version: string;

  /** Tools the server will expose. Must have unique names. */
  readonly tools: readonly HttpToolDefinition[];

  /**
   * Base URL of the Backend HTTP API the tools proxy to. If omitted, the
   * value is read from `process.env.SYNAPSE_MCP_BASE_URL` at server start.
   * If neither is available, the server throws on first tool invocation.
   */
  readonly baseUrl?: string;

  /** Additional HTTP headers applied to every tool call. */
  readonly headers?: Record<string, string>;

  /** Optional custom fetch implementation (defaults to `globalThis.fetch`). */
  readonly fetch?: FetchLike;

  /**
   * Hook invoked when a tool is called. Useful for logging. Does not affect
   * the tool result.
   */
  readonly onToolCall?: (event: { name: string; args: ToolArgs }) => void;
}

/** Handle returned from {@link createMcpServer}. */
export interface McpServerHandle {
  /** Connect the server to a stdio transport and start serving requests. */
  start(): Promise<void>;

  /** Close the transport and release resources. */
  stop(): Promise<void>;

  /**
   * Low-level access to the underlying MCP server instance. Escape hatch
   * for callers that want to register additional request handlers.
   */
  readonly server: Server;
}

function assertUniqueToolNames(tools: readonly HttpToolDefinition[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(
        `createMcpServer: duplicate tool name "${tool.name}". Each tool must have a unique name within one server.`,
      );
    }
    seen.add(tool.name);
  }
}

/**
 * Build an MCP stdio server from a set of declarative HTTP tool definitions.
 *
 * The returned handle is idle until {@link McpServerHandle.start} is
 * invoked. `start()` connects a {@link StdioServerTransport} and begins
 * responding to `tools/list` and `tools/call` requests.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServerHandle {
  const { name, version, tools, headers, fetch: fetchImpl, onToolCall } = options;
  assertUniqueToolNames(tools);

  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  const toolsByName = new Map<string, HttpToolDefinition>();
  for (const tool of tools) toolsByName.set(tool.name, tool);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => {
      const descriptor: {
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      } = {
        name: tool.name,
        inputSchema: augmentSchemaForConfirmation(tool) as Record<string, unknown>,
      };
      if (tool.description) descriptor.description = tool.description;
      return descriptor;
    }),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const { name: toolName, arguments: rawArgs } = request.params;
      const tool = toolsByName.get(toolName);
      if (!tool) {
        const errorResult: ToolResult = {
          isError: true,
          content: [{ type: "text", text: `Unknown tool "${toolName}"` }],
        };
        return errorResult as CallToolResult;
      }

      const args: ToolArgs =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? { ...(rawArgs as ToolArgs) }
          : {};

      onToolCall?.({ name: tool.name, args });

      const confirmationError = checkConfirmation(tool, args);
      if (confirmationError) return confirmationError as CallToolResult;

      const baseUrl = options.baseUrl ?? process.env.SYNAPSE_MCP_BASE_URL;
      if (!baseUrl) {
        const errorResult: ToolResult = {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool "${tool.name}" cannot run: no baseUrl configured. Pass \`baseUrl\` to createMcpServer() or set SYNAPSE_MCP_BASE_URL.`,
            },
          ],
        };
        return errorResult as CallToolResult;
      }

      const callOptions: Parameters<typeof callHttpTool>[0] = {
        tool,
        args: stripConfirmation(args),
        baseUrl,
      };
      if (headers !== undefined) callOptions.headers = headers;
      if (fetchImpl !== undefined) callOptions.fetch = fetchImpl;
      const result = await callHttpTool(callOptions);
      return result as CallToolResult;
    },
  );

  let transport: StdioServerTransport | undefined;

  return {
    server,
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
