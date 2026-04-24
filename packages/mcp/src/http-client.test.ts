import { describe, it, expect, vi } from "vitest";
import {
  callHttpTool,
  encodeQueryString,
  joinUrl,
  substitutePathParams,
  type FetchLike,
} from "./http-client.js";
import type { HttpToolDefinition } from "./types.js";

describe("substitutePathParams", () => {
  it("replaces a single placeholder and removes the key from rest", () => {
    const { path, rest, missing } = substitutePathParams("/api/duties/{id}", {
      id: "42",
      other: "keep",
    });
    expect(path).toBe("/api/duties/42");
    expect(rest).toEqual({ other: "keep" });
    expect(missing).toEqual([]);
  });

  it("URL-encodes substituted values", () => {
    const { path } = substitutePathParams("/api/users/{name}", {
      name: "al ice/bob",
    });
    expect(path).toBe("/api/users/al%20ice%2Fbob");
  });

  it("reports missing placeholders", () => {
    const { path, missing } = substitutePathParams("/api/{a}/{b}", { a: "1" });
    expect(path).toBe("/api/1/{b}");
    expect(missing).toEqual(["b"]);
  });

  it("treats null or undefined values as missing", () => {
    const { missing } = substitutePathParams("/api/{a}", { a: null });
    expect(missing).toEqual(["a"]);
  });

  it("does not mutate the original args object", () => {
    const args = { id: "1" };
    substitutePathParams("/api/{id}", args);
    expect(args).toEqual({ id: "1" });
  });
});

describe("encodeQueryString", () => {
  it("encodes scalar values", () => {
    expect(encodeQueryString({ a: "1", b: 2, c: true })).toBe("a=1&b=2&c=true");
  });

  it("skips undefined and null values", () => {
    expect(encodeQueryString({ a: "1", b: undefined, c: null })).toBe("a=1");
  });

  it("repeats array keys", () => {
    expect(encodeQueryString({ tag: ["a", "b", "c"] })).toBe(
      "tag=a&tag=b&tag=c",
    );
  });

  it("JSON-stringifies nested objects", () => {
    const qs = encodeQueryString({ filter: { a: 1 } });
    expect(qs).toContain("filter=");
    expect(decodeURIComponent(qs.split("=")[1]!)).toBe('{"a":1}');
  });
});

describe("joinUrl", () => {
  it("removes trailing slashes from base and ensures leading slash on path", () => {
    expect(joinUrl("http://x.test/", "api/y")).toBe("http://x.test/api/y");
    expect(joinUrl("http://x.test", "/api/y")).toBe("http://x.test/api/y");
    expect(joinUrl("http://x.test//", "/api/y")).toBe("http://x.test/api/y");
  });
});

function makeFetchMock(impl: (url: string, init?: Parameters<FetchLike>[1]) => {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}): { fetch: FetchLike; calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetchImpl: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const result = impl(url, init);
    return {
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      text: async () => result.body,
    };
  });
  return { fetch: fetchImpl, calls };
}

const getTool: HttpToolDefinition = {
  name: "list_duties",
  method: "GET",
  path: "/api/duties",
};

const postTool: HttpToolDefinition = {
  name: "create_duty",
  method: "POST",
  path: "/api/duties",
};

const pathParamTool: HttpToolDefinition = {
  name: "get_duty",
  method: "GET",
  path: "/api/duties/{id}",
};

describe("callHttpTool", () => {
  it("performs a GET with query string from leftover args", async () => {
    const mock = makeFetchMock(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: '{"items":[]}',
    }));
    const result = await callHttpTool({
      tool: getTool,
      args: { status: "open", limit: 5 },
      baseUrl: "http://backend.test/",
      fetch: mock.fetch,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"items":[]}');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe(
      "http://backend.test/api/duties?status=open&limit=5",
    );
    expect(mock.calls[0]!.init?.method).toBe("GET");
    expect(mock.calls[0]!.init?.body).toBeUndefined();
  });

  it("sends JSON body for POST and sets content-type", async () => {
    const mock = makeFetchMock(() => ({
      ok: true,
      status: 201,
      statusText: "Created",
      body: '{"id":"new-1"}',
    }));
    await callHttpTool({
      tool: postTool,
      args: { title: "t", priority: 3 },
      baseUrl: "http://backend.test",
      fetch: mock.fetch,
    });
    const init = mock.calls[0]!.init!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ title: "t", priority: 3 }));
    expect(init.headers?.["content-type"]).toBe("application/json");
  });

  it("substitutes path params and excludes them from the query / body", async () => {
    const mock = makeFetchMock(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: "{}",
    }));
    await callHttpTool({
      tool: pathParamTool,
      args: { id: "abc", include: "related" },
      baseUrl: "http://backend.test",
      fetch: mock.fetch,
    });
    expect(mock.calls[0]!.url).toBe(
      "http://backend.test/api/duties/abc?include=related",
    );
  });

  it("returns an isError ToolResult when a path param is missing", async () => {
    const mock = makeFetchMock(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: "",
    }));
    const result = await callHttpTool({
      tool: pathParamTool,
      args: {},
      baseUrl: "http://backend.test",
      fetch: mock.fetch,
    });
    expect(result.isError).toBe(true);
    expect(mock.calls).toHaveLength(0);
  });

  it("maps 4xx responses into isError tool results", async () => {
    const mock = makeFetchMock(() => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      body: '{"error":"missing"}',
    }));
    const result = await callHttpTool({
      tool: pathParamTool,
      args: { id: "xxx" },
      baseUrl: "http://backend.test",
      fetch: mock.fetch,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/HTTP 404/);
    expect(result.content[0]!.text).toMatch(/missing/);
  });

  it("maps network errors into isError tool results", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await callHttpTool({
      tool: getTool,
      args: {},
      baseUrl: "http://backend.test",
      fetch: fetchImpl,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/ECONNREFUSED/);
  });

  it("merges per-server and per-tool headers (tool wins)", async () => {
    const mock = makeFetchMock(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: "",
    }));
    const toolWithHeader: HttpToolDefinition = {
      ...getTool,
      headers: { "x-tool": "yes", authorization: "bearer TOOL" },
    };
    await callHttpTool({
      tool: toolWithHeader,
      args: {},
      baseUrl: "http://backend.test",
      headers: { "x-base": "yes", authorization: "bearer BASE" },
      fetch: mock.fetch,
    });
    const headers = mock.calls[0]!.init!.headers!;
    expect(headers["x-base"]).toBe("yes");
    expect(headers["x-tool"]).toBe("yes");
    expect(headers["authorization"]).toBe("bearer TOOL");
  });
});
