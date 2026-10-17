import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "./config.js";
import {
  AGY_MCP_SERVERS_PLUGIN,
  claudeMcpConfigArgs,
  mcpServersLaunch,
  tomlBasicString,
  withdrawMcpServersFiles,
} from "./launch.js";

const artiflow: McpServerConfig = {
  transport: "stdio",
  command: "/usr/bin/node",
  args: ["/srv/artiflow/mcp.js", "--db", "/data/a b.db"],
  env: { ARTIFLOW_TOKEN: "${ARTIFLOW_TOKEN}", MODE: "agent" },
};
const yatagarasu: McpServerConfig = {
  transport: "http",
  url: "http://localhost:8790/${YATA_PASS}/mcp",
  headers: { Authorization: "Bearer ${YATA_TOKEN}" },
};
const env = { ARTIFLOW_TOKEN: "tok-1", YATA_PASS: "pass", YATA_TOKEN: "tok-2" };
const servers = { enabled: [{ name: "artiflow", config: artiflow }, { name: "yatagarasu", config: yatagarasu }] };

describe("mcpServersLaunch: claude", () => {
  it("returns mcpServers entries with the references expanded, and nothing else", () => {
    const l = mcpServersLaunch("claude", servers, { env });
    expect(l.mcpServers).toEqual({
      artiflow: { command: "/usr/bin/node", args: ["/srv/artiflow/mcp.js", "--db", "/data/a b.db"], env: { ARTIFLOW_TOKEN: "tok-1", MODE: "agent" } },
      yatagarasu: { type: "http", url: "http://localhost:8790/pass/mcp", headers: { Authorization: "Bearer tok-2" } },
    });
    expect(l.args).toEqual([]);
    expect(l.files).toEqual({});
    expect(l.delivered).toEqual(["artiflow", "yatagarasu"]);
  });

  it("claudeMcpConfigArgs makes one --mcp-config, the first map winning a name", () => {
    const l = mcpServersLaunch("claude", servers, { env });
    const args = claudeMcpConfigArgs({ skills: { command: "node" }, artiflow: { command: "mine" } }, l.mcpServers);
    expect(args[0]).toBe("--mcp-config");
    const cfg = JSON.parse(args[1]!) as { mcpServers: Record<string, { command?: string }> };
    expect(Object.keys(cfg.mcpServers)).toEqual(["skills", "artiflow", "yatagarasu"]);
    expect(cfg.mcpServers.artiflow!.command).toBe("mine");
    expect(claudeMcpConfigArgs({}, {})).toEqual([]);
  });
});

describe("mcpServersLaunch: codex", () => {
  it("returns -c overrides with the keys of [mcp_servers.<name>]", () => {
    const l = mcpServersLaunch("codex", servers, { env });
    expect(l.args).toEqual([
      "-c", 'mcp_servers.artiflow.command="/usr/bin/node"',
      "-c", 'mcp_servers.artiflow.args=["/srv/artiflow/mcp.js", "--db", "/data/a b.db"]',
      "-c", 'mcp_servers.artiflow.env={ "ARTIFLOW_TOKEN" = "tok-1", "MODE" = "agent" }',
      "-c", 'mcp_servers.yatagarasu.url="http://localhost:8790/pass/mcp"',
      "-c", 'mcp_servers.yatagarasu.http_headers={ "Authorization" = "Bearer tok-2" }',
    ]);
    expect(l.mcpServers).toEqual({});
    expect(l.files).toEqual({});
  });

  it("sends args = [] and cwd for stdio", () => {
    const l = mcpServersLaunch("codex", { enabled: [{ name: "x", config: { transport: "stdio", command: "x", cwd: "/w" } }] }, { env: {} });
    expect(l.args).toEqual(["-c", 'mcp_servers.x.command="x"', "-c", "mcp_servers.x.args=[]", "-c", 'mcp_servers.x.cwd="/w"']);
  });
});

describe("mcpServersLaunch: agy", () => {
  it("returns a workspace plugin whose mcp_config.json holds the servers", () => {
    const l = mcpServersLaunch("agy", {
      enabled: [...servers.enabled, { name: "c", config: { transport: "stdio", command: "x", cwd: "/w" } }],
    }, { env });
    const dir = `.agents/plugins/${AGY_MCP_SERVERS_PLUGIN}`;
    expect(Object.keys(l.files).sort()).toEqual([`${dir}/mcp_config.json`, `${dir}/plugin.json`]);
    expect(JSON.parse(l.files[`${dir}/plugin.json`]!)).toEqual({ name: AGY_MCP_SERVERS_PLUGIN });
    expect(JSON.parse(l.files[`${dir}/mcp_config.json`]!)).toEqual({
      mcpServers: {
        artiflow: { command: "/usr/bin/node", args: ["/srv/artiflow/mcp.js", "--db", "/data/a b.db"], env: { ARTIFLOW_TOKEN: "tok-1", MODE: "agent" } },
        yatagarasu: { serverUrl: "http://localhost:8790/pass/mcp", headers: { Authorization: "Bearer tok-2" } },
        c: { command: "x", cwd: "/w" },
      },
    });
    expect(l.mcpServers).toEqual({});
    expect(l.args).toEqual([]);
    expect(l.skipped).toEqual([]);
  });

  it("writes nothing when there is nothing; the withdrawn form lists no server", () => {
    expect(mcpServersLaunch("agy", { enabled: [] }).files).toEqual({});
    const w = withdrawMcpServersFiles("agy");
    expect(JSON.parse(w[`.agents/plugins/${AGY_MCP_SERVERS_PLUGIN}/mcp_config.json`]!)).toEqual({ mcpServers: {} });
    expect(withdrawMcpServersFiles("claude")).toEqual({});
    expect(withdrawMcpServersFiles("codex")).toEqual({});
  });
});

describe("mcpServersLaunch: what is not handed out", () => {
  it("skips a server whose variable is missing, naming the variable and no value", () => {
    for (const cli of ["claude", "codex", "agy"] as const) {
      const l = mcpServersLaunch(cli, servers, { env: { ARTIFLOW_TOKEN: "tok-1" } });
      expect(l.delivered).toEqual(["artiflow"]);
      expect(l.skipped).toEqual([{ name: "yatagarasu", reason: "環境変数が無い: YATA_PASS, YATA_TOKEN" }]);
      expect(JSON.stringify(l)).not.toContain("yatagarasu.url");
    }
  });

  it("reports disabled servers and leaves reserved names to the caller", () => {
    const l = mcpServersLaunch("claude", { ...servers, disabled: [{ name: "off" }] }, { env, reserved: ["yatagarasu"] });
    expect(l.delivered).toEqual(["artiflow"]);
    expect(l.disabled).toEqual(["off"]);
    expect(l.skipped).toEqual([{ name: "yatagarasu", reason: expect.stringContaining("reserved") }]);
    expect(mcpServersLaunch("codex", { enabled: [{ name: "skills", config: artiflow }] }, { env }).skipped).toHaveLength(1);
  });

  it("skips a value Codex's TOML cannot carry", () => {
    const l = mcpServersLaunch("codex", { enabled: [{ name: "x", config: { transport: "stdio", command: "a\uD800" } }] }, { env: {} });
    expect(l.args).toEqual([]);
    expect(l.skipped[0]!.reason).toMatch(/surrogate/);
  });
});

describe("tomlBasicString", () => {
  const cases = ["plain", "with space", 'quote " inside', "back\\slash", "new\nline", "cr\r\nlf", "tab\t", "del\u007f", "nul\u0000", "日本語", "emoji 🙂", "'single'", "${NOT_EXPANDED}"];

  it("escapes what TOML requires and reads back to the same string", () => {
    for (const s of cases) {
      const t = tomlBasicString(s);
      expect(t).not.toMatch(/[\u0000-\u0008\u000A-\u001F\u007F]/);
      expect(JSON.parse(t)).toBe(s); // every escape used is also a JSON escape
    }
    expect(tomlBasicString("a\u007fb")).toBe('"a\\u007Fb"');
    expect(() => tomlBasicString("\uDC00")).toThrow(/surrogate/);
  });

  // The real check: the codex CLI parses the overrides. Skipped where codex is not installed.
  const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
  const haveCodex = codex.status === 0;
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it.skipIf(!haveCodex)("codex reads the boundary values back unchanged (codex mcp list --json)", () => {
    // A NUL cannot reach an argv anyway; `${…}` would be expanded before it gets here.
    const tricky = cases.filter((s) => !s.includes("\u0000") && !s.includes("${"));
    const l = mcpServersLaunch("codex", {
      enabled: [
        { name: "s", config: { transport: "stdio", command: "/bin/echo", args: tricky, env: { V: tricky.join("|") }, cwd: "/tmp/a \"b\"\n" } },
        { name: "h", config: { transport: "http", url: "http://localhost:9/mcp?q=%22", headers: { "X-V": 'a "b" \'c\' \\ d' } } },
      ],
    }, { env: {} });
    expect(l.skipped).toEqual([]);
    const r = spawnSync("codex", ["mcp", "list", "--json", ...l.args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
    expect(r.stderr).toBe("");
    const list = JSON.parse(r.stdout) as { name: string; transport: Record<string, unknown> }[];
    const s = list.find((x) => x.name === "s")!.transport;
    expect(s.command).toBe("/bin/echo");
    expect(s.args).toEqual(tricky);
    expect(s.env).toEqual({ V: tricky.join("|") });
    expect(s.cwd).toBe("/tmp/a \"b\"\n");
    const h = list.find((x) => x.name === "h")!.transport;
    expect(h.url).toBe("http://localhost:9/mcp?q=%22");
    expect(h.http_headers).toEqual({ "X-V": 'a "b" \'c\' \\ d' });
  });
});

describe("Claude's cwd", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cwd-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("starts the server in cwd through /bin/sh, every value passed as its own argument", () => {
    const cwd = path.join(dir, `a "b" $(echo x) 'c'\nd`);
    fs.mkdirSync(cwd);
    const l = mcpServersLaunch("claude", {
      enabled: [{ name: "p", config: { transport: "stdio", command: "/bin/sh", args: ["-c", 'pwd; printf "%s|" "$@"', "argv0", "x y", "$HOME", "'q'"], cwd } }],
    }, { env: {} });
    const e = l.mcpServers.p as { command: string; args: string[] };
    expect(e.command).toBe("/bin/sh");
    const r = spawnSync(e.command, e.args, { encoding: "utf8", cwd: os.tmpdir() });
    expect(r.status).toBe(0);
    const [pwd, rest] = [r.stdout.slice(0, r.stdout.lastIndexOf("\n")), r.stdout.slice(r.stdout.lastIndexOf("\n") + 1)];
    expect(fs.realpathSync(pwd)).toBe(fs.realpathSync(cwd));
    expect(rest).toBe("x y|$HOME|'q'|");
  });

  it("does not wrap a server without cwd", () => {
    const l = mcpServersLaunch("claude", { enabled: [{ name: "p", config: { transport: "stdio", command: "x" } }] }, { env: {} });
    expect(l.mcpServers.p).toEqual({ command: "x" });
  });
});
