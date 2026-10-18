/**
 * One MCP server as the ledger keeps it, provider-neutral
 * (docs/design/mcp-servers.md).
 *
 * Secrets are not stored: a string value may refer to an environment
 * variable as `${NAME}`, which is expanded at launch from the environment the
 * caller passes in ({@link expandMcpServerConfig}).
 */
import path from "node:path";

/** stdio: the CLI spawns `command` and speaks MCP over its stdin / stdout. */
export interface StdioMcpServerConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Absolute (after expansion). Absent: the CLI's default (Claude / Codex: the session cwd). */
  readonly cwd?: string;
}

/** Streamable HTTP. */
export interface HttpMcpServerConfig {
  readonly transport: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

/** What `put` takes (and what `show` prints): the name, whether it is on, and the transport. */
export type McpServerSpec = McpServerConfig & {
  readonly name: string;
  /** Default `true`. */
  readonly enabled?: boolean;
};

/**
 * The server name, as every CLI uses it: Claude's tool names are
 * `mcp__<name>__<tool>`, so no `__` inside; Codex puts it in a dotted TOML
 * key, so only bare-key characters.
 */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_))*$/;
const MAX_NAME = 64;

/**
 * The names of the servers this package hands out itself: the skills server
 * (`skills/server.ts`) and the peers server (`peers/server.ts`). The ledger
 * never hands out a server under them.
 */
export const RESERVED_MCP_SERVER_NAMES: readonly string[] = ["skills", "peers"];

export function isMcpServerName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_NAME && NAME_RE.test(name);
}

export function assertMcpServerName(name: unknown): asserts name is string {
  if (!isMcpServerName(name)) {
    throw new Error(
      `invalid MCP server name: ${JSON.stringify(name)}（英数字で始まり、英数字・-・_ だけ、__ は不可、${MAX_NAME} 文字まで）`,
    );
  }
  if (RESERVED_MCP_SERVER_NAMES.includes(name)) {
    throw new Error(`MCP server name ${name} is reserved (a server this package hands out itself: skills, peers)`);
  }
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** `${NAME}`; `$${` is a literal `${`. Anything else with a `$` is left as it is. */
const REF_RE = /\$(\$?)\{([^}]*)\}/g;

/** The variables `value` refers to. Throws on a malformed reference (`${}`, `${1X}`, an unclosed `${`). */
export function envReferences(value: string): string[] {
  const names: string[] = [];
  for (const m of value.matchAll(REF_RE)) {
    if (m[1] === "$") continue;
    const name = m[2]!;
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment reference: \${${name}}`);
    names.push(name);
  }
  const rest = value.replace(REF_RE, "");
  if (/\$\{/.test(rest)) throw new Error(`unclosed environment reference in ${JSON.stringify(value)}`);
  return names;
}

/** Expand `${NAME}` from `env`. Missing names are collected, not thrown. */
export function expandEnvReferences(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  missing: Set<string>,
): string {
  envReferences(value);
  return value.replace(REF_RE, (whole, escaped: string, name: string) => {
    if (escaped === "$") return whole.slice(1);
    const v = env[name];
    if (v === undefined) {
      missing.add(name);
      return "";
    }
    return v;
  });
}

const hasRef = (value: string): boolean => envReferences(value).length > 0;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringMap(
  value: unknown,
  what: string,
  keyRe: RegExp,
  checkValue: (k: string, v: string) => void = () => {},
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw new Error(`${what} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!keyRe.test(k)) throw new Error(`${what}: invalid key ${JSON.stringify(k)}`);
    if (typeof v !== "string") throw new Error(`${what}.${k} must be a string`);
    envReferences(v);
    checkValue(k, v);
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${what}: unknown key ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
}

const noNewline = (what: string) => (k: string, v: string) => {
  if (/[\r\n]/.test(v)) throw new Error(`${what}.${k}: a header value cannot contain a line break`);
};

function checkUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never quote the value: after expansion it may hold a secret.
    throw new Error("url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`url must be http(s): ${parsed.protocol}`);
}

/**
 * Validate a transport config and return it in canonical form (fixed key
 * order, empty `args` / `env` / `headers` dropped) so equal configs compare
 * equal as JSON. Values with `${…}` are checked again after expansion.
 */
export function parseMcpServerConfig(raw: unknown): McpServerConfig {
  if (!plainObject(raw)) throw new Error("MCP server config must be a JSON object");
  switch (raw.transport) {
    case "stdio": {
      rejectUnknownKeys(raw, ["transport", "command", "args", "env", "cwd"], "stdio");
      if (typeof raw.command !== "string" || raw.command.trim() === "") throw new Error("stdio: command is required");
      envReferences(raw.command);
      let args: string[] | undefined;
      if (raw.args !== undefined) {
        if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string")) {
          throw new Error("stdio: args must be an array of strings");
        }
        args = (raw.args as string[]).map((a) => (envReferences(a), a));
      }
      const env = stringMap(raw.env, "env", ENV_NAME_RE);
      let cwd: string | undefined;
      if (raw.cwd !== undefined) {
        if (typeof raw.cwd !== "string" || raw.cwd === "") throw new Error("stdio: cwd must be a non-empty string");
        if (!hasRef(raw.cwd) && !path.isAbsolute(raw.cwd)) throw new Error(`stdio: cwd must be absolute: ${raw.cwd}`);
        cwd = raw.cwd;
      }
      return {
        transport: "stdio",
        command: raw.command,
        ...(args && args.length > 0 ? { args } : {}),
        ...(env ? { env } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      };
    }
    case "http": {
      rejectUnknownKeys(raw, ["transport", "url", "headers"], "http");
      if (typeof raw.url !== "string" || raw.url === "") throw new Error("http: url is required");
      if (!hasRef(raw.url)) checkUrl(raw.url);
      const headers = stringMap(raw.headers, "headers", HEADER_NAME_RE, noNewline("headers"));
      return { transport: "http", url: raw.url, ...(headers ? { headers } : {}) };
    }
    default:
      throw new Error(`transport must be "stdio" or "http": ${JSON.stringify(raw.transport)}`);
  }
}

/** A `put` input (a parsed JSON file): name, enabled, and the transport keys. */
export function parseMcpServerSpec(raw: unknown): McpServerSpec & { enabled: boolean } {
  if (!plainObject(raw)) throw new Error("MCP server must be a JSON object");
  const { name, enabled, ...config } = raw;
  assertMcpServerName(name);
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  return { name, enabled: enabled ?? true, ...parseMcpServerConfig(config) };
}

/**
 * Keys whose value looks like a secret written in the clear (no `${…}`).
 * Advisory: the management CLI warns, the store does not refuse.
 */
export function plaintextSecretKeys(config: McpServerConfig): string[] {
  const SECRETISH = /token|secret|key|password|passwd|auth|cookie|credential/i;
  const map = config.transport === "stdio" ? config.env : config.headers;
  const where = config.transport === "stdio" ? "env" : "headers";
  return Object.entries(map ?? {})
    .filter(([k, v]) => SECRETISH.test(k) && !hasRef(v) && v !== "")
    .map(([k]) => `${where}.${k}`);
}

/**
 * The config with every `${NAME}` expanded from `env`, or the names that
 * were not there, or why the expanded value is not usable (a cwd that is not
 * absolute, a URL that is not http(s), a header with a line break).
 */
export function expandMcpServerConfig(
  config: McpServerConfig,
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; config: McpServerConfig } | { ok: false; missing: string[]; problem?: string } {
  const missing = new Set<string>();
  const x = (v: string): string => expandEnvReferences(v, env, missing);
  const map = (m: Readonly<Record<string, string>> | undefined) =>
    m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, x(v)])) : undefined;

  let out: McpServerConfig;
  if (config.transport === "stdio") {
    const env2 = map(config.env);
    out = {
      transport: "stdio",
      command: x(config.command),
      ...(config.args ? { args: config.args.map(x) } : {}),
      ...(env2 ? { env: env2 } : {}),
      ...(config.cwd !== undefined ? { cwd: x(config.cwd) } : {}),
    };
  } else {
    const headers = map(config.headers);
    out = { transport: "http", url: x(config.url), ...(headers ? { headers } : {}) };
  }
  if (missing.size > 0) return { ok: false, missing: [...missing].sort() };

  try {
    if (out.transport === "stdio") {
      if (out.command.trim() === "") throw new Error("command is empty after expansion");
      if (out.cwd !== undefined && !path.isAbsolute(out.cwd)) throw new Error(`cwd is not absolute after expansion`);
    } else {
      checkUrl(out.url);
      for (const [k, v] of Object.entries(out.headers ?? {})) noNewline("headers")(k, v);
    }
  } catch (e) {
    return { ok: false, missing: [], problem: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, config: out };
}
