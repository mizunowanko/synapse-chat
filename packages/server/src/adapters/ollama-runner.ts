/**
 * In-process implementation of an Ollama-backed CLI runner.
 *
 * The runner POSTs a chat request to an Ollama HTTP server, then projects the
 * response onto the stream-json format that {@link parseGemmaOutput} (and
 * therefore {@link parseStreamMessage}) understands. It supports both
 * streaming (NDJSON tokens forwarded as they arrive) and non-streaming
 * (single buffered response emitted once at the end) modes.
 */

export interface OllamaRunnerOptions {
  /** Ollama model name (`-m`). Required. */
  model: string;
  /** Prompt sent as a single user message (`-p`). Required. */
  prompt: string;
  /** When `true`, request streaming NDJSON; when `false`, request a single response. */
  stream: boolean;
  /** Base URL of the Ollama HTTP server. Defaults to `http://localhost:11434`. */
  host?: string;
  /** Override fetch implementation (used by tests). */
  fetchImpl?: typeof fetch;
  /** Write a stream-json line to stdout. Defaults to `console.log`. */
  writeLine?: (line: string) => void;
}

interface OllamaChatChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
  };
  done?: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

const DEFAULT_HOST = "http://localhost:11434";

/**
 * Run a single Ollama chat completion and emit stream-json lines.
 *
 * Returns the accumulated assistant content (for callers that want to inspect
 * the result without re-parsing stdout).
 */
export async function runOllama(
  options: OllamaRunnerOptions,
): Promise<{ content: string; thinking: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeLine = options.writeLine ?? ((line: string) => console.log(line));
  const host = options.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const url = new URL("/api/chat", host).toString();

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: options.prompt }],
      stream: options.stream,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama request failed: ${response.status} ${response.statusText} ${body}`.trim(),
    );
  }

  let accumulatedContent = "";
  let accumulatedThinking = "";
  let promptTokens = 0;
  let completionTokens = 0;

  const processChunk = (chunk: OllamaChatChunk) => {
    const thinking = chunk.message?.thinking;
    if (typeof thinking === "string" && thinking.length > 0) {
      accumulatedThinking += thinking;
      writeLine(
        JSON.stringify({
          type: "assistant",
          subtype: "thinking",
          content: thinking,
        }),
      );
    }
    const content = chunk.message?.content;
    if (typeof content === "string" && content.length > 0) {
      accumulatedContent += content;
      writeLine(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content },
        }),
      );
    }
    if (chunk.done) {
      promptTokens = chunk.prompt_eval_count ?? promptTokens;
      completionTokens = chunk.eval_count ?? completionTokens;
    }
  };

  if (options.stream) {
    if (!response.body) {
      throw new Error("Ollama streaming response has no body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          const parsed = parseChunk(line);
          if (parsed) processChunk(parsed);
        }
      }
      if (done) break;
    }
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseChunk(tail);
      if (parsed) processChunk(parsed);
    }
  } else {
    const body = await response.text();
    const parsed = parseChunk(body.trim());
    if (parsed) processChunk(parsed);
  }

  writeLine(
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: accumulatedContent,
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
      },
    }),
  );

  return { content: accumulatedContent, thinking: accumulatedThinking };
}

function parseChunk(line: string): OllamaChatChunk | null {
  try {
    return JSON.parse(line) as OllamaChatChunk;
  } catch {
    return null;
  }
}

export interface ParsedRunnerArgs {
  model: string;
  prompt: string;
  stream: boolean;
  host?: string;
}

/**
 * Parse argv passed to the CLI entry point. Mirrors `buildGemmaArgs`:
 * `-m <model> -p <prompt> [--stream|--no-stream]` plus an optional
 * `--host <url>` override.
 */
export function parseRunnerArgs(argv: readonly string[]): ParsedRunnerArgs {
  let model: string | undefined;
  let prompt: string | undefined;
  let stream = true;
  let host: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-m":
      case "--model":
        model = argv[++i];
        break;
      case "-p":
      case "--prompt":
        prompt = argv[++i];
        break;
      case "--stream":
      case "-s":
        stream = true;
        break;
      case "--no-stream":
        stream = false;
        break;
      case "--host":
        host = argv[++i];
        break;
      default:
        // Ignore unknown flags so future SessionOptions additions don't break
        // the runner. buildGemmaArgs only emits the flags above today.
        break;
    }
  }

  if (!model) throw new Error("ollama-runner: -m <model> is required");
  if (!prompt) throw new Error("ollama-runner: -p <prompt> is required");

  return { model, prompt, stream, ...(host ? { host } : {}) };
}
