import { describe, it, expect } from "vitest";
import { buildCodexArgs, parseCodexOutput, codexAdapter } from "./codex.js";

/**
 * Verbatim lines captured from `codex-cli` 0.153.4 on 2026-09-10. Do not
 * hand-edit: the point of these fixtures is that they are what the CLI
 * actually emitted.
 */
const FIXTURES = {
  threadStarted: `{"type":"thread.started","thread_id":"01a08bba-16dc-79a2-8a4a-44dc65161902"}`,
  turnStarted: `{"type":"turn.started"}`,
  agentMessage: `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"BANANAPHONE"}}`,
  commandStarted: `{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'echo hello-from-tool'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  commandCompleted: `{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'echo hello-from-tool'","aggregated_output":"hello-from-tool\\n","exit_code":0,"status":"completed"}}`,
  turnCompleted: `{"type":"turn.completed","usage":{"input_tokens":27356,"cached_input_tokens":23040,"cache_write_input_tokens":0,"output_tokens":108,"reasoning_output_tokens":37}}`,
};

describe("buildCodexArgs", () => {
  it("uses the exec subcommand with JSONL output", () => {
    const args = buildCodexArgs({ prompt: "hello" });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
  });

  it("always passes --skip-git-repo-check so non-repo cwds work", () => {
    // Without it codex exits with "Not inside a trusted directory and
    // --skip-git-repo-check was not specified."
    expect(buildCodexArgs({ prompt: "hi" })).toContain("--skip-git-repo-check");
    expect(buildCodexArgs({ prompt: "hi", cwd: "/tmp/x" })).toContain(
      "--skip-git-repo-check",
    );
  });

  it("maps cwd to -C", () => {
    const args = buildCodexArgs({ prompt: "hi", cwd: "/work/repo" });
    const idx = args.indexOf("-C");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/work/repo");
  });

  it("maps model to -m", () => {
    const args = buildCodexArgs({ prompt: "hi", model: "gpt-5.6-luna" });
    const idx = args.indexOf("-m");
    expect(args[idx + 1]).toBe("gpt-5.6-luna");
  });

  it("maps autoApprove to the sandbox bypass flag", () => {
    expect(buildCodexArgs({ prompt: "hi", autoApprove: true })).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(buildCodexArgs({ prompt: "hi" })).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("passes the prompt as a trailing positional argument", () => {
    const args = buildCodexArgs({ prompt: "hello", cwd: "/w" });
    expect(args[args.length - 1]).toBe("hello");
  });

  it("emits every option before the resume subcommand", () => {
    // clap rejects `codex exec resume <id> -C /tmp` with
    // "error: unexpected argument '-C' found".
    const args = buildCodexArgs({
      prompt: "again",
      cwd: "/work/repo",
      model: "gpt-5.6-luna",
      resumeSessionId: "thread-1",
    });
    const resumeIdx = args.indexOf("resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(args[resumeIdx + 1]).toBe("thread-1");
    expect(args[resumeIdx + 2]).toBe("again");
    for (const flag of ["--json", "--skip-git-repo-check", "-C", "-m"]) {
      expect(args.indexOf(flag)).toBeLessThan(resumeIdx);
    }
  });

  it("prepends systemPrompt to the prompt (codex has no append flag)", () => {
    const args = buildCodexArgs({ prompt: "do it", systemPrompt: "be terse" });
    expect(args[args.length - 1]).toBe("be terse\n\ndo it");
    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("parseCodexOutput", () => {
  it("returns null for blank and non-JSON lines", () => {
    expect(parseCodexOutput("")).toBeNull();
    expect(parseCodexOutput("Reading additional input from stdin...")).toBeNull();
  });

  it("maps thread.started to a system message carrying the thread id", () => {
    const message = parseCodexOutput(FIXTURES.threadStarted);
    expect(message).toMatchObject({ type: "system", subtype: "init" });
    expect(message?.meta).toEqual({
      threadId: "01a08bba-16dc-79a2-8a4a-44dc65161902",
    });
  });

  it("skips turn.started, which carries no payload", () => {
    expect(parseCodexOutput(FIXTURES.turnStarted)).toBeNull();
  });

  it("maps a completed agent_message to an assistant message", () => {
    expect(parseCodexOutput(FIXTURES.agentMessage)).toEqual({
      type: "assistant",
      content: "BANANAPHONE",
    });
  });

  it("ignores a started agent_message so text is not emitted twice", () => {
    // Only item.completed carries the final text; forwarding item.started too
    // would duplicate the assistant bubble.
    expect(
      parseCodexOutput(
        `{"type":"item.started","item":{"id":"item_1","type":"agent_message","text":"BANANA"}}`,
      ),
    ).toBeNull();
  });

  it("maps a started command_execution to tool_use", () => {
    const message = parseCodexOutput(FIXTURES.commandStarted);
    expect(message).toMatchObject({
      type: "tool_use",
      tool: "command_execution",
      toolUseId: "item_0",
      content: "/bin/zsh -lc 'echo hello-from-tool'",
    });
  });

  it("maps a completed command_execution to tool_result with exit code", () => {
    const message = parseCodexOutput(FIXTURES.commandCompleted);
    expect(message).toMatchObject({
      type: "tool_result",
      content: "hello-from-tool\n",
      toolUseId: "item_0",
    });
    expect(message?.meta).toMatchObject({
      tool: "command_execution",
      exitCode: 0,
    });
  });

  it("maps turn.completed to result with normalized usage", () => {
    const message = parseCodexOutput(FIXTURES.turnCompleted);
    expect(message).toMatchObject({ type: "result" });
    expect(message?.type === "result" && message.usage).toEqual({
      inputTokens: 27356,
      outputTokens: 108,
      cacheRead: 23040,
    });
  });

  it("maps turn.failed to an error message", () => {
    const message = parseCodexOutput(
      `{"type":"turn.failed","error":{"message":"model overloaded"}}`,
    );
    expect(message).toEqual({ type: "error", content: "model overloaded" });
  });

  it("skips unrecognized item types instead of guessing", () => {
    expect(
      parseCodexOutput(
        `{"type":"item.completed","item":{"id":"i","type":"todo_list","items":[]}}`,
      ),
    ).toBeNull();
  });
});

describe("codexAdapter", () => {
  it("defaults its command to codex and honours CODEX_CLI_PATH", () => {
    expect(codexAdapter.command).toBe(process.env.CODEX_CLI_PATH ?? "codex");
  });

  it("omits formatInput — codex exec has no interactive turn protocol", () => {
    expect(codexAdapter.formatInput).toBeUndefined();
  });

  it("detects rate limits and retryable errors", () => {
    const rateLimited = (s: string) =>
      codexAdapter.rateLimitPatterns.some((p) => p.test(s));
    expect(rateLimited("HTTP 429 too many requests")).toBe(true);
    expect(rateLimited("fine")).toBe(false);
    expect(
      codexAdapter.retryableErrorPatterns.some((p) => p.test("ETIMEDOUT")),
    ).toBe(true);
  });
});
