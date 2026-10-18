import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeMcpConfigArgs } from "../mcp-servers/launch.js";
import { main } from "./cli.js";
import {
  AGY_PEERS_PLUGIN,
  agyPeersPluginFiles,
  claudePeersMcpConfig,
  claudePeersMcpServers,
  codexPeersConfigArgs,
  peersServerEntry,
  withdrawPeersFiles,
} from "./registration.js";

const launch = { api: "http://127.0.0.1:8123", token: "tok_x-Y", node: "/usr/bin/node", cli: "/pkg/dist/peers/cli.js" };
const ARGS = ["/pkg/dist/peers/cli.js", "serve", "--api", "http://127.0.0.1:8123", "--token", "tok_x-Y"];

describe("peersServerEntry", () => {
  it("puts the URL and the token in the launch arguments", () => {
    expect(peersServerEntry(launch)).toEqual({ command: "/usr/bin/node", args: ARGS });
    expect(peersServerEntry({ ...launch, log: "/tmp/p.jsonl", timeoutMs: 5000 }).args).toEqual([
      ...ARGS,
      "--log",
      "/tmp/p.jsonl",
      "--timeout-ms",
      "5000",
    ]);
  });

  it("defaults to the running Node and this package's cli.js", () => {
    const e = peersServerEntry({ api: launch.api, token: launch.token });
    expect(e.command).toBe(process.execPath);
    expect(e.args?.[0]).toMatch(/peers[/\\]cli\.js$/);
    expect(path.isAbsolute(e.args![0]!)).toBe(true);
  });

  it("refuses what would break the server or the header", () => {
    expect(() => peersServerEntry({ ...launch, api: "localhost:8001" })).toThrow(/http/);
    expect(() => peersServerEntry({ ...launch, api: "ftp://x" })).toThrow(/http/);
    expect(() => peersServerEntry({ ...launch, api: "http://x/?a=1" })).toThrow(/query/);
    expect(() => peersServerEntry({ ...launch, token: "" })).toThrow(/token/);
    expect(() => peersServerEntry({ ...launch, token: "a b" })).toThrow(/token/);
    expect(() => peersServerEntry({ ...launch, token: "a\nb" })).toThrow(/token/);
    expect(() => peersServerEntry({ ...launch, log: "rel.jsonl" })).toThrow(/absolute/);
    expect(() => peersServerEntry({ ...launch, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

describe("per CLI", () => {
  it("Claude: an mcpServers entry named peers, mergeable into one --mcp-config", () => {
    expect(claudePeersMcpServers(launch)).toEqual({ peers: { command: "/usr/bin/node", args: ARGS } });
    expect(claudePeersMcpConfig(launch)).toEqual({ mcpServers: { peers: { command: "/usr/bin/node", args: ARGS } } });
    const merged = claudeMcpConfigArgs(claudePeersMcpServers(launch), { other: { command: "x" } });
    expect(JSON.parse(merged[1]!)).toEqual({ mcpServers: { peers: { command: "/usr/bin/node", args: ARGS }, other: { command: "x" } } });
  });

  it("Codex: -c mcp_servers.peers.command / .args as TOML", () => {
    expect(codexPeersConfigArgs(launch)).toEqual([
      "-c",
      'mcp_servers.peers.command="/usr/bin/node"',
      "-c",
      `mcp_servers.peers.args=[${ARGS.map((a) => JSON.stringify(a)).join(", ")}]`,
    ]);
    const odd = codexPeersConfigArgs({ ...launch, cli: '/p "q"\\cli.js' });
    expect(odd[3]).toContain('"/p \\"q\\"\\\\cli.js"');
  });

  it("agy: its own workspace plugin, apart from the ledger's and the skills'", () => {
    const files = agyPeersPluginFiles(launch);
    expect(AGY_PEERS_PLUGIN).toBe("synapse-peers");
    expect(Object.keys(files).sort()).toEqual([
      ".agents/plugins/synapse-peers/mcp_config.json",
      ".agents/plugins/synapse-peers/plugin.json",
    ]);
    expect(JSON.parse(files[".agents/plugins/synapse-peers/plugin.json"]!)).toEqual({ name: "synapse-peers" });
    expect(JSON.parse(files[".agents/plugins/synapse-peers/mcp_config.json"]!)).toEqual({
      mcpServers: { peers: { command: "/usr/bin/node", args: ARGS } },
    });
  });

  it("withdrawal: agy gets the plugin with no server; the others have nothing on disk", () => {
    const files = withdrawPeersFiles("agy");
    expect(JSON.parse(files[".agents/plugins/synapse-peers/mcp_config.json"]!)).toEqual({ mcpServers: {} });
    expect(Object.keys(files)).toHaveLength(2);
    expect(withdrawPeersFiles("claude")).toEqual({});
    expect(withdrawPeersFiles("codex")).toEqual({});
  });
});

describe("synapse-peers", () => {
  let output: string[];
  let dir: string;
  beforeEach(() => {
    output = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-cli-"));
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (output.push(String(s)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("register claude / codex print what the CLI would be given", async () => {
    expect(await main(["register", "claude", "--api", launch.api, "--token", launch.token])).toBe(0);
    const cfg = JSON.parse(output.join("")) as { mcpServers: { peers: { args: string[] } } };
    expect(cfg.mcpServers.peers.args.slice(1)).toEqual(ARGS.slice(1));
    output = [];
    expect(await main(["register", "codex", "--api", launch.api, "--token", launch.token])).toBe(0);
    expect(output.join("")).toMatch(/^"-c" "mcp_servers\.peers\.command=/);
  });

  it("register agy --out writes the plugin, owner-only (it holds the token)", async () => {
    expect(await main(["register", "agy", "--api", launch.api, "--token", launch.token, "--out", dir])).toBe(0);
    const p = path.join(dir, ".agents/plugins/synapse-peers/mcp_config.json");
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p, "utf8")).toContain(launch.token);
  });

  it("needs --api and --token (there is no environment fallback)", async () => {
    await expect(main(["serve", "--api", launch.api])).rejects.toThrow(/--token/);
    await expect(main(["serve", "--token", "t"])).rejects.toThrow(/--api/);
    await expect(main(["serve", "--api", "nope", "--token", "t"])).rejects.toThrow(/http/);
    await expect(main(["register", "vim", "--api", launch.api, "--token", "t"])).rejects.toThrow(/unknown CLI/);
  });
});
