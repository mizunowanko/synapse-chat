import { describe, it, expect } from "vitest";
import { parseRunnerArgs, runOllama } from "./ollama-runner.js";

function makeStreamingResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("parseRunnerArgs", () => {
  it("parses -m and -p plus default stream=true", () => {
    expect(parseRunnerArgs(["-m", "gemma3", "-p", "hello"])).toEqual({
      model: "gemma3",
      prompt: "hello",
      stream: true,
    });
  });

  it("recognises --no-stream", () => {
    expect(
      parseRunnerArgs(["-m", "gemma3", "-p", "hi", "--no-stream"]),
    ).toMatchObject({ stream: false });
  });

  it("accepts --host override", () => {
    expect(
      parseRunnerArgs([
        "-m",
        "gemma3",
        "-p",
        "hi",
        "--host",
        "http://example.test",
      ]),
    ).toMatchObject({ host: "http://example.test" });
  });

  it("throws when -m is missing", () => {
    expect(() => parseRunnerArgs(["-p", "hi"])).toThrow(/-m/);
  });

  it("throws when -p is missing", () => {
    expect(() => parseRunnerArgs(["-m", "gemma3"])).toThrow(/-p/);
  });
});

describe("runOllama (streaming)", () => {
  it("forwards thinking and content chunks as stream-json lines then a result", async () => {
    const lines: string[] = [];
    const writeLine = (line: string) => lines.push(line);

    const fetchImpl = (async () =>
      makeStreamingResponse([
        JSON.stringify({ message: { role: "assistant", thinking: "Hmm " }, done: false }),
        JSON.stringify({ message: { role: "assistant", thinking: "let me think." }, done: false }),
        JSON.stringify({ message: { role: "assistant", content: "Hello" }, done: false }),
        JSON.stringify({ message: { role: "assistant", content: " world" }, done: false }),
        JSON.stringify({
          message: { role: "assistant", content: "" },
          done: true,
          prompt_eval_count: 5,
          eval_count: 10,
        }),
      ])) as unknown as typeof fetch;

    const result = await runOllama({
      model: "gemma3",
      prompt: "hi",
      stream: true,
      fetchImpl,
      writeLine,
    });

    expect(result.content).toBe("Hello world");
    expect(result.thinking).toBe("Hmm let me think.");

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ type: "assistant", subtype: "thinking", content: "Hmm " });
    expect(parsed[1]).toMatchObject({ type: "assistant", subtype: "thinking", content: "let me think." });
    expect(parsed[2]).toMatchObject({
      type: "assistant",
      message: { role: "assistant", content: "Hello" },
    });
    expect(parsed[3]).toMatchObject({
      type: "assistant",
      message: { role: "assistant", content: " world" },
    });
    expect(parsed[parsed.length - 1]).toMatchObject({
      type: "result",
      result: "Hello world",
      usage: { input_tokens: 5, output_tokens: 10 },
    });
  });

  it("passes stream: true in the request body", async () => {
    let observed: { stream?: boolean } | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      observed = JSON.parse(init?.body as string);
      return makeStreamingResponse([
        JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }),
      ]);
    }) as unknown as typeof fetch;

    await runOllama({
      model: "gemma3",
      prompt: "hi",
      stream: true,
      fetchImpl,
      writeLine: () => {},
    });

    expect(observed?.stream).toBe(true);
  });
});

describe("runOllama (non-streaming)", () => {
  it("emits a single assistant chunk then a result", async () => {
    const lines: string[] = [];
    const writeLine = (line: string) => lines.push(line);

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          message: { role: "assistant", content: "Hello world" },
          done: true,
          prompt_eval_count: 3,
          eval_count: 7,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await runOllama({
      model: "gemma3",
      prompt: "hi",
      stream: false,
      fetchImpl,
      writeLine,
    });

    expect(result.content).toBe("Hello world");

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      type: "assistant",
      message: { role: "assistant", content: "Hello world" },
    });
    expect(parsed[1]).toMatchObject({
      type: "result",
      result: "Hello world",
      usage: { input_tokens: 3, output_tokens: 7 },
    });
  });

  it("passes stream: false in the request body", async () => {
    let observed: { stream?: boolean } | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      observed = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ message: { content: "ok" }, done: true }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await runOllama({
      model: "gemma3",
      prompt: "hi",
      stream: false,
      fetchImpl,
      writeLine: () => {},
    });

    expect(observed?.stream).toBe(false);
  });

  it("emits both thinking and content from a single response", async () => {
    const lines: string[] = [];
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          message: { role: "assistant", thinking: "deliberating", content: "done" },
          done: true,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await runOllama({
      model: "gemma3",
      prompt: "hi",
      stream: false,
      fetchImpl,
      writeLine: (line) => lines.push(line),
    });

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({
      type: "assistant",
      subtype: "thinking",
      content: "deliberating",
    });
    expect(parsed[1]).toMatchObject({
      type: "assistant",
      message: { content: "done" },
    });
  });
});

describe("runOllama (errors)", () => {
  it("throws when the response is not OK", async () => {
    const fetchImpl = (async () =>
      new Response("bad model", { status: 404 })) as unknown as typeof fetch;

    await expect(
      runOllama({
        model: "missing",
        prompt: "hi",
        stream: true,
        fetchImpl,
        writeLine: () => {},
      }),
    ).rejects.toThrow(/Ollama request failed/);
  });
});
