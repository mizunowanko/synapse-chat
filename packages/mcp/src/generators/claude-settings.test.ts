import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateClaudeSettings,
  writeClaudeSettings,
} from "./claude-settings.js";

describe("generateClaudeSettings", () => {
  it("produces mcpJson with the server entries and local settings that enable them", () => {
    const { mcpJson, localSettings } = generateClaudeSettings({
      "my-backend": { command: "node", args: ["./server.mjs"] },
    });
    expect(mcpJson.mcpServers).toEqual({
      "my-backend": { command: "node", args: ["./server.mjs"] },
    });
    expect(localSettings.enableAllProjectMcpServers).toBe(true);
    expect(localSettings.enabledMcpjsonServers).toContain("my-backend");
  });

  it("merges with existing mcpJson and keeps existing servers", () => {
    const { mcpJson, localSettings } = generateClaudeSettings(
      { "new-one": { command: "node" } },
      {
        mcpJson: {
          mcpServers: {
            keep: { command: "x" },
          },
          customField: "preserved",
        },
        localSettings: {
          enabledMcpjsonServers: ["keep"],
          unrelated: "leave-alone",
        },
      },
    );
    expect(mcpJson.mcpServers).toEqual({
      keep: { command: "x" },
      "new-one": { command: "node" },
    });
    expect(mcpJson.customField).toBe("preserved");
    expect(localSettings.enabledMcpjsonServers).toEqual(
      expect.arrayContaining(["keep", "new-one"]),
    );
    expect(localSettings.unrelated).toBe("leave-alone");
  });

  it("does not duplicate existing server names in enabledMcpjsonServers", () => {
    const { localSettings } = generateClaudeSettings(
      { "my-backend": { command: "node" } },
      {
        localSettings: { enabledMcpjsonServers: ["my-backend"] },
      },
    );
    const count = (localSettings.enabledMcpjsonServers ?? []).filter(
      (n) => n === "my-backend",
    ).length;
    expect(count).toBe(1);
  });
});

describe("writeClaudeSettings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-settings-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes .mcp.json and .claude/settings.local.json when absent", async () => {
    const { mcpJsonPath, localSettingsPath } = await writeClaudeSettings(dir, {
      "my-backend": { command: "node", args: ["./s.mjs"] },
    });
    expect(mcpJsonPath).toBe(join(dir, ".mcp.json"));
    expect(localSettingsPath).toBe(join(dir, ".claude", "settings.local.json"));

    const mcpJson = JSON.parse(await readFile(mcpJsonPath, "utf8"));
    expect(mcpJson.mcpServers["my-backend"]).toEqual({
      command: "node",
      args: ["./s.mjs"],
    });

    const local = JSON.parse(await readFile(localSettingsPath, "utf8"));
    expect(local.enableAllProjectMcpServers).toBe(true);
    expect(local.enabledMcpjsonServers).toContain("my-backend");
  });

  it("merges with existing files and preserves unrelated keys", async () => {
    const mcpPath = join(dir, ".mcp.json");
    const localPath = join(dir, ".claude", "settings.local.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: { keep: { command: "x" } },
        version: 1,
      }),
      "utf8",
    );
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      localPath,
      JSON.stringify({
        enabledMcpjsonServers: ["keep"],
        someUserPref: "yes",
      }),
      "utf8",
    );

    await writeClaudeSettings(dir, { "new-one": { command: "node" } });

    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    expect(mcp.mcpServers).toEqual({
      keep: { command: "x" },
      "new-one": { command: "node" },
    });
    expect(mcp.version).toBe(1);

    const local = JSON.parse(await readFile(localPath, "utf8"));
    expect(local.someUserPref).toBe("yes");
    expect(local.enableAllProjectMcpServers).toBe(true);
    expect(local.enabledMcpjsonServers).toEqual(
      expect.arrayContaining(["keep", "new-one"]),
    );
  });
});
