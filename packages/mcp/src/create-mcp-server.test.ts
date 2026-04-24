import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./create-mcp-server.js";
import { defineHttpTool } from "./define-http-tool.js";
import type { FetchLike } from "./http-client.js";
import type { HttpToolDefinition } from "./types.js";

function stubFetch(
  impl: (url: string, init?: Parameters<FetchLike>[1]) => {
    ok: boolean;
    status: number;
    statusText: string;
    body: string;
  },
): FetchLike {
  return async (url, init) => {
    const result = impl(url, init);
    return {
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      text: async () => result.body,
    };
  };
}

async function connect(tools: HttpToolDefinition[], overrides: {
  fetch?: FetchLike;
  baseUrl?: string;
  onToolCall?: (event: { name: string; args: Record<string, unknown> }) => void;
} = {}): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const handle = createMcpServer({
    name: "test-server",
    version: "0.0.0",
    tools,
    baseUrl: overrides.baseUrl ?? "http://backend.test",
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.onToolCall ? { onToolCall: overrides.onToolCall } : {}),
  });
  await handle.server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    async close() {
      await client.close();
      await handle.stop();
    },
  };
}

describe("createMcpServer — tools/list", () => {
  it("advertises every registered tool", async () => {
    const tools = [
      defineHttpTool({
        name: "list_items",
        description: "List items",
        method: "GET",
        path: "/api/items",
      }),
      defineHttpTool({
        name: "delete_item",
        method: "DELETE",
        path: "/api/items/{id}",
        confirmation: true,
      }),
    ];
    const { client, close } = await connect(tools);
    try {
      const { tools: advertised } = await client.listTools();
      expect(advertised).toHaveLength(2);
      const names = advertised.map((t) => t.name).sort();
      expect(names).toEqual(["delete_item", "list_items"]);
      const del = advertised.find((t) => t.name === "delete_item")!;
      const delSchema = del.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(delSchema.properties.confirmed).toBeDefined();
      expect(delSchema.required).toContain("confirmed");
    } finally {
      await close();
    }
  });
});

describe("createMcpServer — tools/call", () => {
  it("proxies a GET tool call through the injected fetch", async () => {
    const fetchMock = vi.fn(
      stubFetch(() => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: '{"count":3}',
      })),
    );
    const tools = [
      defineHttpTool({
        name: "list_items",
        method: "GET",
        path: "/api/items",
      }),
    ];
    const { client, close } = await connect(tools, { fetch: fetchMock });
    try {
      const result = await client.callTool({
        name: "list_items",
        arguments: { limit: 2 },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe('{"count":3}');
      expect(fetchMock).toHaveBeenCalledOnce();
      const firstCallArgs = fetchMock.mock.calls[0]!;
      expect(firstCallArgs[0]).toBe("http://backend.test/api/items?limit=2");
    } finally {
      await close();
    }
  });

  it("short-circuits confirmation-required tools without confirmed=true", async () => {
    const fetchMock = vi.fn(
      stubFetch(() => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: "{}",
      })),
    );
    const tools = [
      defineHttpTool({
        name: "delete_item",
        method: "DELETE",
        path: "/api/items/{id}",
        confirmation: true,
      }),
    ];
    const { client, close } = await connect(tools, { fetch: fetchMock });
    try {
      const result = await client.callTool({
        name: "delete_item",
        arguments: { id: "abc" },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ text: string }>;
      expect(content[0]!.text).toMatch(/confirmed=true/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("executes confirmation-required tools when confirmed=true", async () => {
    const fetchMock = vi.fn(
      stubFetch(() => ({
        ok: true,
        status: 204,
        statusText: "No Content",
        body: "",
      })),
    );
    const tools = [
      defineHttpTool({
        name: "delete_item",
        method: "DELETE",
        path: "/api/items/{id}",
        confirmation: true,
      }),
    ];
    const { client, close } = await connect(tools, { fetch: fetchMock });
    try {
      const result = await client.callTool({
        name: "delete_item",
        arguments: { id: "abc", confirmed: true },
      });
      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledOnce();
      const firstCallArgs = fetchMock.mock.calls[0]!;
      expect(firstCallArgs[0]).toBe("http://backend.test/api/items/abc");
      expect(firstCallArgs[1]?.method).toBe("DELETE");
      expect(firstCallArgs[1]?.body).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("returns isError tool result for unknown tool names", async () => {
    const tools = [
      defineHttpTool({
        name: "known",
        method: "GET",
        path: "/",
      }),
    ];
    const { client, close } = await connect(tools, {
      fetch: stubFetch(() => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: "",
      })),
    });
    try {
      const result = await client.callTool({
        name: "unknown",
        arguments: {},
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("fires onToolCall hook for every invocation", async () => {
    const events: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = [
      defineHttpTool({
        name: "ping",
        method: "GET",
        path: "/",
      }),
    ];
    const { client, close } = await connect(tools, {
      fetch: stubFetch(() => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: "ok",
      })),
      onToolCall: (e) => events.push(e),
    });
    try {
      await client.callTool({ name: "ping", arguments: { q: "1" } });
      expect(events).toEqual([{ name: "ping", args: { q: "1" } }]);
    } finally {
      await close();
    }
  });

  it("rejects duplicate tool names at construction time", () => {
    expect(() =>
      createMcpServer({
        name: "dup",
        version: "0",
        tools: [
          { name: "same", method: "GET", path: "/a" },
          { name: "same", method: "GET", path: "/b" },
        ],
      }),
    ).toThrow(/duplicate tool name/);
  });
});
