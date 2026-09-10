import { describe, it, expect } from "vitest";
import {
  buildAgyArgs,
  parseAgyOutput,
  formatAgyInput,
  agyAdapter,
} from "./agy.js";

/**
 * Verbatim lines captured from `agy` 1.2.0 on 2026-09-10. Do not hand-edit:
 * the point of these fixtures is that they are what the CLI actually emitted.
 */
const FIXTURES = {
  init: `{"event":"init","conversation_id":"0b3d8ea3-81a5-4037-b57d-bd67277f893e","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/cli-probe","tools":["run_command","view_file"],"permission_mode":"always-proceed"}}`,
  userInputStep: `{"event":"step_update","step_update":{"conversation_id":"0b3d8ea3-81a5-4037-b57d-bd67277f893e","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  textDelta: `{"event":"step_update","step_update":{"conversation_id":"8b35b268-d774-440a-8c79-c991dd8e761e","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"コマンドの実行結果"}}`,
  toolActive: `{"event":"step_update","step_update":{"conversation_id":"8b35b268-d774-440a-8c79-c991dd8e761e","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello-from-tool"}}}}`,
  toolDone: `{"event":"step_update","step_update":{"conversation_id":"8b35b268-d774-440a-8c79-c991dd8e761e","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.067248,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello-from-tool"},"output":"hello-from-tool\\n"}}}`,
  result: `{"event":"result","result":{"conversation_id":"0b3d8ea3-81a5-4037-b57d-bd67277f893e","status":"SUCCESS","response":"BANANAPHONE\\n","duration_seconds":1.708302,"num_turns":1,"usage":{"input_tokens":13574,"output_tokens":4,"thinking_tokens":0,"cache_read_tokens":8129,"total_tokens":13578}}}`,
  errorResult: `{"event":"result","result":{"conversation_id":"4650f02f-3530-4701-ad47-c3ac6b717bd4","status":"ERROR","response":"","error":"stream input message is missing the \\"event\\" field","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}`,
};

describe("buildAgyArgs", () => {
  it("requests stream-json output for a one-shot prompt", () => {
    const args = buildAgyArgs({ prompt: "hello" });
    expect(args.slice(0, 4)).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
    ]);
  });

  it("always forwards cwd as --add-dir", () => {
    // Regression guard: without a workspace agy answers without reading any
    // file, which looks like a dumb model rather than a missing flag.
    const args = buildAgyArgs({ prompt: "hi", cwd: "/work/repo" });
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/work/repo");
  });

  it("omits --add-dir when no cwd is supplied", () => {
    expect(buildAgyArgs({ prompt: "hi" })).not.toContain("--add-dir");
  });

  it("resumes with --conversation, not --resume", () => {
    const args = buildAgyArgs({ prompt: "hi", resumeSessionId: "conv-123" });
    expect(args).not.toContain("--resume");
    const idx = args.indexOf("--conversation");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("conv-123");
  });

  it("passes the model through --model", () => {
    const args = buildAgyArgs({ prompt: "hi", model: "gemini-3.8-flash-low" });
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("gemini-3.8-flash-low");
  });

  it("maps autoApprove to --dangerously-skip-permissions", () => {
    expect(buildAgyArgs({ prompt: "hi", autoApprove: true })).toContain(
      "--dangerously-skip-permissions",
    );
    expect(buildAgyArgs({ prompt: "hi" })).not.toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("never combines a CLI prompt with --input-format (agy rejects it)", () => {
    // agy: "--input-format stream-json reads prompts from stdin, so a prompt
    // given on the command line would be ignored" — exits 2.
    const args = buildAgyArgs({ prompt: "hello" });
    expect(args).not.toContain("--input-format");
  });

  it("switches to the stdin turn protocol when no prompt is given", () => {
    const args = buildAgyArgs({});
    expect(args).toContain("--print=");
    expect(args).not.toContain("-p");
    const idx = args.indexOf("--input-format");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("stream-json");
  });

  it("prepends systemPrompt to the prompt (agy has no append flag)", () => {
    const args = buildAgyArgs({ prompt: "do it", systemPrompt: "be terse" });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("be terse\n\ndo it");
    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("parseAgyOutput", () => {
  it("returns null for blank and non-JSON lines", () => {
    expect(parseAgyOutput("")).toBeNull();
    expect(parseAgyOutput("   ")).toBeNull();
    expect(parseAgyOutput("not json at all")).toBeNull();
  });

  it("maps init to a system message carrying the conversation id", () => {
    const message = parseAgyOutput(FIXTURES.init);
    expect(message).toMatchObject({ type: "system", subtype: "init" });
    expect(message?.meta).toMatchObject({
      conversationId: "0b3d8ea3-81a5-4037-b57d-bd67277f893e",
      model: "gemini-3.8-flash-low",
      cwd: "/tmp/cli-probe",
    });
  });

  it("maps an agent_response text_delta to an assistant chunk", () => {
    expect(parseAgyOutput(FIXTURES.textDelta)).toEqual({
      type: "assistant",
      content: "コマンドの実行結果",
    });
  });

  it("preserves delta whitespace verbatim so chunks concatenate cleanly", () => {
    // agy splits mid-sentence and emits bare "\n" as a final delta; trimming
    // here would silently glue words together in the rendered bubble.
    const line = `{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"\\nhello-from-tool\\n"}}`;
    expect(parseAgyOutput(line)).toEqual({
      type: "assistant",
      content: "\nhello-from-tool\n",
    });
  });

  it("skips step_updates that carry no payload", () => {
    expect(parseAgyOutput(FIXTURES.userInputStep)).toBeNull();
  });

  it("maps an ACTIVE tool step to tool_use with its parameters", () => {
    const message = parseAgyOutput(FIXTURES.toolActive);
    expect(message).toMatchObject({
      type: "tool_use",
      tool: "run_command",
      toolUseId: "step-2",
    });
    expect(message?.type === "tool_use" && message.toolInput).toEqual({
      CommandLine: "echo hello-from-tool",
    });
  });

  it("maps a DONE tool step to tool_result with the captured output", () => {
    const message = parseAgyOutput(FIXTURES.toolDone);
    expect(message).toMatchObject({
      type: "tool_result",
      content: "hello-from-tool\n",
      toolUseId: "step-2",
    });
    expect(message?.meta).toMatchObject({ tool: "run_command" });
  });

  it("maps a SUCCESS result to result with normalized usage", () => {
    const message = parseAgyOutput(FIXTURES.result);
    expect(message).toMatchObject({
      type: "result",
      content: "BANANAPHONE\n",
    });
    expect(message?.type === "result" && message.usage).toEqual({
      inputTokens: 13574,
      outputTokens: 4,
      cacheRead: 8129,
    });
  });

  it("maps an ERROR result to an error message, not an empty result", () => {
    const message = parseAgyOutput(FIXTURES.errorResult);
    expect(message).toEqual({
      type: "error",
      content: 'stream input message is missing the "event" field',
    });
  });
});

describe("formatAgyInput", () => {
  it("wraps the turn in agy's event envelope, not Claude's", () => {
    // agy rejects {"type":"user",…} with: stream input message is missing the
    // "event" field.
    const parsed = JSON.parse(formatAgyInput("Say OK."));
    expect(parsed).toEqual({
      event: "user",
      message: { role: "user", content: "Say OK." },
    });
  });
});

describe("agyAdapter", () => {
  it("defaults its command to agy and honours AGY_CLI_PATH", () => {
    expect(agyAdapter.command).toBe(process.env.AGY_CLI_PATH ?? "agy");
  });

  it("detects rate limits and retryable errors", () => {
    const rateLimited = (s: string) =>
      agyAdapter.rateLimitPatterns.some((p) => p.test(s));
    expect(rateLimited("status 429 RESOURCE_EXHAUSTED")).toBe(true);
    expect(rateLimited("all good")).toBe(false);
    expect(
      agyAdapter.retryableErrorPatterns.some((p) => p.test("ECONNRESET")),
    ).toBe(true);
  });
});
