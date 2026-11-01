import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { toPixel, toPoint, toPointRect, isBrowser } from "./policy.js";
import {
  AGY_DESKTOP_PLUGIN,
  agyDesktopPluginFiles,
  claudeDesktopMcpServers,
  codexDesktopConfigArgs,
  desktopServerEntry,
  withdrawDesktopFiles,
} from "./registration.js";

const launch = { api: "http://127.0.0.1:8123", deskId: "desk-1", node: "/usr/bin/node", cli: "/pkg/dist/desktop/cli.js" };
const ARGS = ["/pkg/dist/desktop/cli.js", "serve", "--api", "http://127.0.0.1:8123", "--desk-id", "desk-1"];

describe("desktopServerEntry", () => {
  it("puts the API, the desk id and the options in the launch arguments", () => {
    expect(desktopServerEntry(launch)).toEqual({ command: "/usr/bin/node", args: ARGS });
    expect(
      desktopServerEntry({ ...launch, token: "t", socket: "/s/h.sock", helperApp: "/A/H.app", log: "/l.jsonl", approvalTimeoutMs: 5000 }).args,
    ).toEqual([...ARGS, "--token", "t", "--socket", "/s/h.sock", "--helper-app", "/A/H.app", "--log", "/l.jsonl", "--approval-timeout-ms", "5000"]);
  });

  it("refuses what would break the server", () => {
    expect(() => desktopServerEntry({ ...launch, api: "localhost:8001" })).toThrow(/http/);
    expect(() => desktopServerEntry({ ...launch, deskId: "" })).toThrow(/deskId/);
    expect(() => desktopServerEntry({ ...launch, deskId: "a b" })).toThrow(/deskId/);
    expect(() => desktopServerEntry({ ...launch, socket: "rel.sock" })).toThrow(/absolute/);
    expect(() => desktopServerEntry({ ...launch, approvalTimeoutMs: 0 })).toThrow(/approvalTimeoutMs/);
  });
});

describe("per CLI", () => {
  it("Claude / Codex under the name desktop (or the one given)", () => {
    expect(claudeDesktopMcpServers(launch)).toEqual({ desktop: { command: "/usr/bin/node", args: ARGS } });
    expect(Object.keys(claudeDesktopMcpServers({ ...launch, name: "computer" }))).toEqual(["computer"]);
    expect(() => claudeDesktopMcpServers({ ...launch, name: "a.b" })).toThrow(/name/);
    expect(codexDesktopConfigArgs(launch)).toEqual([
      "-c",
      'mcp_servers.desktop.command="/usr/bin/node"',
      "-c",
      `mcp_servers.desktop.args=[${ARGS.map((a) => JSON.stringify(a)).join(", ")}]`,
    ]);
  });

  it("agy: its own plugin; withdrawal leaves an empty one", () => {
    const files = agyDesktopPluginFiles(launch);
    expect(AGY_DESKTOP_PLUGIN).toBe("synapse-desktop");
    expect(JSON.parse(files[".agents/plugins/synapse-desktop/mcp_config.json"]!)).toEqual({ mcpServers: { desktop: { command: "/usr/bin/node", args: ARGS } } });
    expect(JSON.parse(withdrawDesktopFiles("agy")[".agents/plugins/synapse-desktop/mcp_config.json"]!)).toEqual({ mcpServers: {} });
    expect(withdrawDesktopFiles("claude")).toEqual({});
  });

  it("the CLI needs --api and --desk-id", async () => {
    await expect(main(["serve", "--api", launch.api])).rejects.toThrow(/--desk-id/);
    await expect(main(["serve", "--desk-id", "d"])).rejects.toThrow(/--api/);
    await expect(main(["register", "vim", "--api", launch.api, "--desk-id", "d"])).rejects.toThrow(/unknown CLI/);
  });
});

describe("policy", () => {
  const g = { width: 1456, height: 910, originX: 0, originY: 0, pointWidth: 1512, pointHeight: 945 };

  it("pixels and points round-trip", () => {
    const p = toPoint(g, 728, 455);
    expect(p).toEqual({ x: 756, y: 472.5 });
    expect(toPixel(g, p.x, p.y)).toEqual({ x: 728, y: 455 });
    expect(() => toPoint(g, 1456, 0)).toThrow(RangeError);
  });

  it("a region is clamped to the screenshot", () => {
    const r = toPointRect(g, [-10, 0, 1456, 910]);
    expect(r.x).toBe(0);
    expect(r.width).toBeCloseTo(1512, 6);
    expect(r.height).toBeCloseTo(945, 6);
    expect(() => toPointRect(g, [10, 10, 5, 20])).toThrow(/x1 > x0/);
  });

  it("knows the common browsers, case-insensitively", () => {
    for (const b of ["com.apple.Safari", "com.google.chrome", "company.thebrowser.Browser", "org.mozilla.firefox", "com.microsoft.edgemac"]) {
      expect(isBrowser(b)).toBe(true);
    }
    expect(isBrowser("com.apple.TextEdit")).toBe(false);
  });
});
