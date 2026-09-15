import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";

// CLI_PATH is read at module load, so point it at a harmless binary before
// importing. The assertions only read the argv the manager built.
process.env.CLAUDE_CLI_PATH = "/bin/echo";
const { ProcessManager, COMMANDER_ALLOWED_TOOLS } = await import(
  "./process-manager.js"
);

describe("ProcessManager.launchCommander", () => {
  const manager = new ProcessManager();
  const spawned: { kill(): void }[] = [];

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }
  });

  function argvOf(
    id: string,
    allowedTools?: string,
    partialMessages?: boolean,
  ): string[] {
    const proc = manager.launchCommander(
      id,
      tmpdir(),
      [],
      undefined,
      undefined,
      allowedTools,
      partialMessages,
    );
    spawned.push(proc);
    return proc.spawnargs;
  }

  it("defaults to the read-only commander allowlist", () => {
    const argv = argvOf("default-tools");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
      COMMANDER_ALLOWED_TOOLS,
    );
  });

  it("uses an explicit allowlist when given one", () => {
    const tools = "Bash,Read,Write,Edit,Glob,Grep";
    const argv = argvOf("explicit-tools", tools);
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(tools);
  });

  it("does not stream token deltas by default", () => {
    expect(argvOf("no-partials")).not.toContain("--include-partial-messages");
  });

  it("streams token deltas when asked", () => {
    expect(argvOf("partials", undefined, true)).toContain(
      "--include-partial-messages",
    );
  });
});
