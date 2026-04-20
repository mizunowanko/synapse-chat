import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateGeminiSettings,
  writeGeminiSettings,
} from "./gemini-settings.js";

describe("generateGeminiSettings", () => {
  it("produces a settings payload with the mcpServers map", () => {
    const settings = generateGeminiSettings({
      "my-backend": { command: "node", args: ["./server.mjs"] },
    });
    expect(settings).toEqual({
      mcpServers: {
        "my-backend": { command: "node", args: ["./server.mjs"] },
      },
    });
  });

  it("merges new servers over existing entries without losing others", () => {
    const settings = generateGeminiSettings(
      { "new-one": { command: "node", args: ["./new.mjs"] } },
      {
        theme: "dark",
        mcpServers: {
          "keep-me": { command: "node", args: ["./keep.mjs"] },
          "new-one": { command: "node", args: ["./OLD.mjs"] },
        },
      },
    );
    expect(settings.theme).toBe("dark");
    expect(settings.mcpServers).toEqual({
      "keep-me": { command: "node", args: ["./keep.mjs"] },
      "new-one": { command: "node", args: ["./new.mjs"] },
    });
  });
});

describe("writeGeminiSettings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gemini-settings-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes .gemini/settings.json when none exists", async () => {
    const path = await writeGeminiSettings(dir, {
      "my-backend": { command: "node", args: ["./s.mjs"] },
    });
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      mcpServers: { "my-backend": { command: "node", args: ["./s.mjs"] } },
    });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("merges with existing settings.json and preserves unrelated keys", async () => {
    const settingsPath = join(dir, ".gemini", "settings.json");
    await mkdir(join(dir, ".gemini"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ theme: "light", mcpServers: { keep: { command: "x" } } }),
      "utf8",
    );
    await writeGeminiSettings(dir, {
      "new-one": { command: "node" },
    });
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(parsed.theme).toBe("light");
    expect(parsed.mcpServers).toEqual({
      keep: { command: "x" },
      "new-one": { command: "node" },
    });
  });
});
