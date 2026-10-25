import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as instructionsMain } from "../instructions/cli.js";
import { main } from "./cli.js";

let dir: string;
let db: string;
let output: string[];

const run = (...argv: string[]): Promise<number> => main([...argv, "--db", db], { ARTIFLOW_TOKEN: "tok" });
const text = (): string => output.join("");
const write = (name: string, value: unknown): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-servers-cli-"));
  db = path.join(dir, "skills.db");
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (output.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (output.push(String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const artiflow = {
  name: "artiflow",
  transport: "stdio",
  command: "node",
  args: ["/srv/artiflow/mcp.js"],
  env: { ARTIFLOW_TOKEN: "${ARTIFLOW_TOKEN}" },
};

describe("synapse-mcp-servers", () => {
  it("put --dry-run validates and does not create the store", async () => {
    expect(await run("put", write("a.json", artiflow), "--agent", "Homura", "--dry-run")).toBe(0);
    expect(text()).toContain("would put artiflow (stdio, on) → エージェント Homura");
    expect(fs.existsSync(db)).toBe(false);
    await expect(run("put", write("bad.json", { ...artiflow, transport: "sse" }), "--global")).rejects.toThrow(/transport/);
    await expect(run("put", write("bad2.json", "{"), "--global")).rejects.toThrow();
    expect(fs.existsSync(db)).toBe(false);
  });

  it("a write must name its tier", async () => {
    const f = write("a.json", artiflow);
    await expect(run("put", f)).rejects.toThrow(/--global か --agent/);
    await expect(run("put", f, "--global", "--agent", "A")).rejects.toThrow(/同時/);
    await expect(run("put", f, "--desk", "d")).rejects.toThrow(/--agent が要る/);
  });

  it("warns about a secret written in the clear", async () => {
    await run("put", write("a.json", { ...artiflow, env: { ARTIFLOW_TOKEN: "plain" } }), "--global", "--dry-run");
    expect(text()).toMatch(/warning: artiflow の env\.ARTIFLOW_TOKEN/);
  });

  it("puts, lists, shows, removes and keeps history", async () => {
    await run("put", write("g.json", { name: "y", transport: "http", url: "https://g/mcp" }), "--global");
    await run("put", write("a.json", artiflow), "--agent", "Homura");
    await run("put", write("a.json", artiflow), "--agent", "Homura");
    expect(text()).toContain("unchanged artiflow → エージェント Homura v1");
    await run("put", write("off.json", { name: "y", enabled: false, transport: "http", url: "https://g/mcp" }), "--agent", "Homura", "--desk", "d1");

    output = [];
    await run("list");
    expect(text().trim().split("\n").map((l) => l.split("\t").slice(0, 5).join(" "))).toEqual([
      "全員 y v1 http on",
      "エージェント Homura artiflow v1 stdio on",
      "Desk Homura/d1 y v2 http off",
    ]);

    output = [];
    await run("list", "--effective", "--agent", "Homura", "--desk", "d1");
    expect(text().trim().split("\n").map((l) => l.split("\t").slice(0, 5).join(" "))).toEqual([
      "エージェント Homura artiflow v1 stdio on",
      "Desk Homura/d1 y v2 http off",
    ]);

    output = [];
    await run("show", "artiflow", "--agent", "Homura");
    expect(JSON.parse(text())).toEqual({ ...artiflow, enabled: true });
    await expect(run("show", "artiflow")).rejects.toThrow(/全員 に artiflow は無い/);

    output = [];
    await run("launch", "codex", "--agent", "Homura");
    const launch = JSON.parse(text()) as { args: string[]; delivered: string[]; disabled: string[] };
    expect(launch.delivered).toEqual(["artiflow", "y"]);
    expect(launch.args).toContain('mcp_servers.artiflow.env={ "ARTIFLOW_TOKEN" = "tok" }');

    await run("rm", "artiflow", "--agent", "Homura");
    await expect(run("rm", "artiflow", "--agent", "Homura")).rejects.toThrow(/無い/);
    output = [];
    await run("history", "artiflow");
    expect(text().trim().split("\n").map((l) => l.split("\t").slice(0, 2).join(" "))).toEqual(["v1 live", "v2 deleted"]);
  });

  it("marks a server that has a UI: in the file or with --ui; show round-trips it, list --ui lists only those", async () => {
    const app = { name: "cards", transport: "http", url: "https://apps/mcp" };
    await run("put", write("app.json", app), "--global", "--ui", "--dry-run");
    expect(text()).toContain("would put cards (http, on, ui) → 全員");
    await run("put", write("app.json", app), "--global", "--ui");
    await run("put", write("app2.json", { ...app, ui: true }), "--agent", "Homura");
    await run("put", write("a.json", artiflow), "--agent", "Homura");

    output = [];
    await run("list", "--ui");
    expect(text().trim().split("\n").map((l) => l.split("\t").slice(0, 6).join(" "))).toEqual([
      "全員 cards v1 http on ui",
      "エージェント Homura cards v2 http on ui",
    ]);
    output = [];
    await run("list", "--effective", "--agent", "Homura", "--ui");
    expect(text().trim().split("\n").map((l) => l.split("\t").slice(0, 2).join(" "))).toEqual(["エージェント Homura cards"]);

    output = [];
    await run("show", "cards");
    const shown = JSON.parse(text()) as Record<string, unknown>;
    expect(shown).toEqual({ ...app, enabled: true, ui: true });
    output = [];
    await run("put", write("back.json", shown), "--global");
    expect(text()).toContain("unchanged cards");
    output = [];
    await run("show", "artiflow", "--agent", "Homura");
    expect(JSON.parse(text())).not.toHaveProperty("ui");
  });

  it("--desk-id keys the desk tier, and --effective / launch read --desk beneath it (agt-215)", async () => {
    await run("put", write("old.json", { name: "y", transport: "http", url: "https://by-name" }), "--agent", "Homura", "--desk", "main");
    await run("put", write("new.json", { name: "z", transport: "http", url: "https://by-id" }), "--agent", "Homura", "--desk-id", "desk-1", "--desk", "main");
    output = [];
    await run("list", "--effective", "--agent", "Homura", "--desk-id", "desk-1", "--desk", "main");
    expect(text().trim().split("\n").map((l) => l.split("\t").slice(0, 3).join(" "))).toEqual([
      "Desk Homura/main y v1",
      "Desk Homura/desk-1 z v1",
    ]);
    output = [];
    await run("show", "z", "--agent", "Homura", "--desk-id", "desk-1");
    expect((JSON.parse(text()) as { url: string }).url).toBe("https://by-id");

    output = [];
    await instructionsMain(["launch", "claude", "--cwd", dir, "--agent", "Homura", "--desk-id", "desk-1", "--desk", "main", "--db", db], {});
    expect((JSON.parse(text()) as { mcp: { delivered: string[] } }).mcp.delivered).toEqual(["y", "z"]);
    await expect(run("list", "--effective", "--desk-id", "desk-1")).rejects.toThrow(/--agent/);
  });

  it("synapse-instructions launch carries the servers under mcp", async () => {
    await run("put", write("a.json", artiflow), "--agent", "Homura");
    output = [];
    await instructionsMain(["launch", "claude", "--cwd", dir, "--agent", "Homura", "--db", db], { ARTIFLOW_TOKEN: "tok" });
    const launch = JSON.parse(text()) as { args: string[]; mcp: { mcpServers: Record<string, { env: Record<string, string> }> } };
    expect(launch.mcp.mcpServers.artiflow!.env).toEqual({ ARTIFLOW_TOKEN: "tok" });
    expect(launch.args).toEqual([]);

    output = [];
    await instructionsMain(["launch", "claude", "--cwd", dir, "--agent", "Other", "--db", db], {});
    expect((JSON.parse(text()) as { mcp: { delivered: string[] } }).mcp.delivered).toEqual([]);
  });
});
