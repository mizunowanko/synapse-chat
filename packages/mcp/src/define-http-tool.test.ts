import { describe, it, expect } from "vitest";
import { defineHttpTool } from "./define-http-tool.js";

describe("defineHttpTool", () => {
  it("returns the input definition unchanged when valid", () => {
    const tool = defineHttpTool({
      name: "list_duties",
      description: "List all duties",
      method: "GET",
      path: "/api/duties",
    });
    expect(tool.name).toBe("list_duties");
    expect(tool.method).toBe("GET");
    expect(tool.description).toBe("List all duties");
  });

  it("accepts tool names starting with underscore", () => {
    const tool = defineHttpTool({
      name: "_internal_ping",
      method: "GET",
      path: "/_ping",
    });
    expect(tool.name).toBe("_internal_ping");
  });

  it("accepts hyphens and digits in tool names", () => {
    const tool = defineHttpTool({
      name: "get-user-v2",
      method: "GET",
      path: "/api/v2/user",
    });
    expect(tool.name).toBe("get-user-v2");
  });

  it("rejects tool names starting with a digit", () => {
    expect(() =>
      defineHttpTool({
        name: "1bad",
        method: "GET",
        path: "/x",
      } as never),
    ).toThrow(/invalid tool name/);
  });

  it("rejects empty name", () => {
    expect(() =>
      defineHttpTool({ name: "", method: "GET", path: "/x" } as never),
    ).toThrow();
  });

  it("rejects missing method", () => {
    expect(() =>
      defineHttpTool({ name: "x", path: "/y" } as never),
    ).toThrow(/method.*required/);
  });

  it("rejects paths without a leading slash", () => {
    expect(() =>
      defineHttpTool({ name: "bad", method: "GET", path: "api/x" } as never),
    ).toThrow(/must start with "\/"/);
  });

  it("preserves confirmation flag on returned definition", () => {
    const tool = defineHttpTool({
      name: "delete_thing",
      method: "DELETE",
      path: "/api/thing/{id}",
      confirmation: true,
    });
    expect(tool.confirmation).toBe(true);
  });
});
