import type { HttpToolDefinition, ToolArgs, ToolResult } from "./types.js";

/** Minimal fetch signature the helper relies on. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

/** Options for a single HTTP tool invocation. */
export interface CallHttpToolOptions {
  tool: HttpToolDefinition;
  args: ToolArgs;
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

const PATH_PARAM_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Substitute `{name}` segments in `path` using values consumed from `args`.
 * Consumed keys are removed from the returned `rest` so they do not leak into
 * the query string or body.
 */
export function substitutePathParams(
  path: string,
  args: ToolArgs,
): { path: string; rest: ToolArgs; missing: string[] } {
  const missing: string[] = [];
  const rest: ToolArgs = { ...args };
  const substituted = path.replace(PATH_PARAM_PATTERN, (_match, rawKey) => {
    const key = rawKey as string;
    if (!(key in rest)) {
      missing.push(key);
      return `{${key}}`;
    }
    const value = rest[key];
    delete rest[key];
    if (value === undefined || value === null) {
      missing.push(key);
      return `{${key}}`;
    }
    return encodeURIComponent(String(value));
  });
  return { path: substituted, rest, missing };
}

/**
 * Build a URL-encoded query string from an arg bag. Arrays are repeated;
 * nested objects are JSON-stringified. `undefined` / `null` values are
 * skipped so optional params disappear silently.
 */
export function encodeQueryString(args: ToolArgs): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
      }
      continue;
    }
    if (typeof value === "object") {
      params.append(key, JSON.stringify(value));
      continue;
    }
    params.append(key, String(value));
  }
  return params.toString();
}

/**
 * Join a base URL and a (possibly substituted) path without double-slashes.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Execute an HTTP tool call and convert the response into an MCP-shaped
 * `ToolResult`. 4xx / 5xx responses are mapped to `isError: true` so the LLM
 * sees the failure and can choose to retry or report.
 */
export async function callHttpTool(options: CallHttpToolOptions): Promise<ToolResult> {
  const {
    tool,
    args,
    baseUrl,
    headers: serverHeaders = {},
    fetch: fetchImpl = globalThis.fetch as unknown as FetchLike,
    signal,
  } = options;

  if (!fetchImpl) {
    throw new Error(
      "callHttpTool: no fetch implementation available. Node 18+ ships `globalThis.fetch`; in older runtimes pass `fetch` explicitly.",
    );
  }

  const { path: resolvedPath, rest, missing } = substitutePathParams(tool.path, args);
  if (missing.length > 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool "${tool.name}" missing required path parameter(s): ${missing.join(", ")}`,
        },
      ],
    };
  }

  let url = joinUrl(baseUrl, resolvedPath);
  const method = tool.method.toUpperCase();
  let body: string | undefined;

  const mergedHeaders: Record<string, string> = {
    accept: "application/json",
    ...serverHeaders,
    ...(tool.headers ?? {}),
  };

  if (BODY_METHODS.has(method)) {
    if (Object.keys(rest).length > 0) {
      body = JSON.stringify(rest);
      mergedHeaders["content-type"] = mergedHeaders["content-type"] ?? "application/json";
    }
  } else if (Object.keys(rest).length > 0) {
    const qs = encodeQueryString(rest);
    if (qs.length > 0) url = url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
  }

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    const init: Parameters<FetchLike>[1] = {
      method,
      headers: mergedHeaders,
    };
    if (body !== undefined) init.body = body;
    if (signal !== undefined) init.signal = signal;
    response = await fetchImpl(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool "${tool.name}" request failed: ${message}`,
        },
      ],
    };
  }

  const rawText = await response.text();

  if (!response.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool "${tool.name}" HTTP ${response.status} ${response.statusText}\n${rawText}`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: rawText }],
  };
}
