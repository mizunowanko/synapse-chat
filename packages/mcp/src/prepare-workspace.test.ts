import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMcpWorkspace } from "./prepare-workspace.js";

describe("prepareMcpWorkspace", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prepare-mcp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes Gemini settings for cli=gemini", async () => {
    const result = await prepareMcpWorkspace(dir, {
      cli: "gemini",
      mcpServers: { api: { command: "node" } },
    });
    expect(result.geminiSettingsPath).toBe(
      join(dir, ".gemini", "settings.json"),
    );
    expect(result.mcpJsonPath).toBeUndefined();
    const parsed = JSON.parse(
      await readFile(result.geminiSettingsPath!, "utf8"),
    );
    expect(parsed.mcpServers.api).toEqual({ command: "node" });
  });

  it("writes Claude settings for cli=claude", async () => {
    const result = await prepareMcpWorkspace(dir, {
      cli: "claude",
      mcpServers: { api: { command: "node" } },
    });
    expect(result.mcpJsonPath).toBe(join(dir, ".mcp.json"));
    expect(result.claudeLocalSettingsPath).toBe(
      join(dir, ".claude", "settings.local.json"),
    );
    expect(result.geminiSettingsPath).toBeUndefined();

    const mcp = JSON.parse(await readFile(result.mcpJsonPath!, "utf8"));
    expect(mcp.mcpServers.api).toEqual({ command: "node" });
    const local = JSON.parse(
      await readFile(result.claudeLocalSettingsPath!, "utf8"),
    );
    expect(local.enableAllProjectMcpServers).toBe(true);
  });

  it("is idempotent across repeated invocations", async () => {
    await prepareMcpWorkspace(dir, {
      cli: "claude",
      mcpServers: { api: { command: "node" } },
    });
    const second = await prepareMcpWorkspace(dir, {
      cli: "claude",
      mcpServers: { api: { command: "node" } },
    });
    const local = JSON.parse(
      await readFile(second.claudeLocalSettingsPath!, "utf8"),
    );
    const count = (local.enabledMcpjsonServers as string[]).filter(
      (n) => n === "api",
    ).length;
    expect(count).toBe(1);
  });
});
