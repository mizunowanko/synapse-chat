import { describe, it, expect } from "vitest";
import {
  deriveAllowedTools,
  formatMcpToolName,
} from "./allowed-tools.js";
import { defineHttpTool } from "../define-http-tool.js";

describe("formatMcpToolName", () => {
  it("prefixes with mcp__ for Claude", () => {
    expect(formatMcpToolName("claude", "my-backend", "list_items")).toBe(
      "mcp__my-backend__list_items",
    );
  });

  it("omits the mcp__ prefix for Gemini", () => {
    expect(formatMcpToolName("gemini", "my-backend", "list_items")).toBe(
      "my-backend__list_items",
    );
  });
});

describe("deriveAllowedTools", () => {
  const tools = [
    defineHttpTool({ name: "list_items", method: "GET", path: "/items" }),
    defineHttpTool({ name: "create_item", method: "POST", path: "/items" }),
  ];

  it("produces the Claude allow-list format", () => {
    const names = deriveAllowedTools({
      cli: "claude",
      servers: { backend: tools },
    });
    expect(names).toEqual([
      "mcp__backend__list_items",
      "mcp__backend__create_item",
    ]);
  });

  it("produces the Gemini allow-list format", () => {
    const names = deriveAllowedTools({
      cli: "gemini",
      servers: { backend: tools },
    });
    expect(names).toEqual(["backend__list_items", "backend__create_item"]);
  });

  it("handles multiple servers", () => {
    const names = deriveAllowedTools({
      cli: "claude",
      servers: {
        a: [defineHttpTool({ name: "ping", method: "GET", path: "/" })],
        b: [defineHttpTool({ name: "pong", method: "GET", path: "/" })],
      },
    });
    expect(names).toEqual(["mcp__a__ping", "mcp__b__pong"]);
  });
});
