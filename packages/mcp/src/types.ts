/**
 * Types for the `@synapse-chat/mcp` helper package.
 *
 * The package centres on two shapes:
 *
 * - {@link HttpToolDefinition} — a declarative description of a single
 *   Backend HTTP endpoint that should be exposed as an MCP tool.
 * - {@link McpServerEntryConfig} — the `.mcp.json` / `.gemini/settings.json`
 *   entry used to spawn an MCP server from a CLI agent.
 */

/** HTTP methods the helper understands. */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A JSON Schema object. Accepted as-is by the MCP SDK so callers can author
 * schemas with any generator (hand-written, Zod → JSON Schema, OpenAPI, …).
 * We keep this loose on purpose to avoid coupling the helper to a specific
 * validator.
 */
export type JsonSchema = Record<string, unknown>;

/** Primitive bag of arguments passed from the LLM to a tool invocation. */
export type ToolArgs = Record<string, unknown>;

/**
 * Declarative definition of a Backend HTTP endpoint exposed as an MCP tool.
 *
 * `path` may contain `{placeholder}` segments that are filled from the
 * incoming `args` at call time. Remaining args become the request body
 * (POST/PUT/PATCH) or query string (GET/HEAD/DELETE).
 */
export interface HttpToolDefinition {
  /** MCP-visible tool name. Must be unique within one server. */
  readonly name: string;

  /** Optional human-readable description shown to the LLM. */
  readonly description?: string;

  /** HTTP method used when the tool is invoked. */
  readonly method: HttpMethod;

  /**
   * Request path (appended to the server `baseUrl`). May contain
   * `{name}` placeholders that are substituted from the tool args.
   */
  readonly path: string;

  /**
   * JSON Schema for the tool input. Optional — omit for zero-arg tools.
   * When {@link confirmation} is `true`, the helper automatically adds a
   * `confirmed: boolean` property and marks it required; callers do not need
   * to describe it themselves.
   */
  readonly inputSchema?: JsonSchema;

  /**
   * If `true`, the tool is treated as a destructive / side-effectful action
   * and the helper enforces an explicit `confirmed: true` argument before
   * issuing the HTTP call. A missing or falsy `confirmed` short-circuits
   * with an MCP error response so the LLM can re-invoke intentionally.
   */
  readonly confirmation?: boolean;

  /** Additional HTTP headers applied to this tool only. */
  readonly headers?: Record<string, string>;
}

/**
 * Response returned by a tool invocation. Roughly mirrors the MCP
 * `CallToolResult` shape but with only the fields the helper emits.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * One entry in a Gemini / Claude settings file. Mirrors the shape accepted
 * by both CLIs: `command` + optional `args` + optional `env`.
 */
export interface McpServerEntryConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Map of server name → spawn config, as used in Gemini / Claude settings. */
export type McpServersConfig = Record<string, McpServerEntryConfig>;

/** CLI target for generators that need CLI-specific formatting. */
export type CliTarget = "claude" | "gemini";
