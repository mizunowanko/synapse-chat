import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import type { CLIAdapter, SessionOptions } from "@synapse-chat/core";
import { ProcessManager } from "./process-manager.js";

/**
 * Adapter that records the {@link SessionOptions} it was handed and spawns a
 * trivial process, so we can assert on the translation without invoking a real
 * CLI.
 */
function recordingAdapter(): {
  adapter: CLIAdapter;
  seen: SessionOptions[];
} {
  const seen: SessionOptions[] = [];
  const adapter: CLIAdapter = {
    command: "true",
    buildArgs(options) {
      seen.push({ ...options });
      return [];
    },
    parseOutput: () => null,
    rateLimitPatterns: [],
    retryableErrorPatterns: [],
  };
  return { adapter, seen };
}

describe("ProcessManager.dispatch", () => {
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

  it("forwards cwd into SessionOptions", () => {
    // Regression guard: dispatch used to pass cwd only to spawn(), so an
    // adapter could never translate it into a workspace flag. `agy` reads no
    // files at all without --add-dir, and fails silently by just answering
    // without having looked at the repo.
    const { adapter, seen } = recordingAdapter();
    spawned.push(
      manager.dispatch("test-cwd", { cwd: tmpdir(), prompt: "hi", adapter }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe(tmpdir());
  });

  it("forwards model into SessionOptions", () => {
    const { adapter, seen } = recordingAdapter();
    spawned.push(
      manager.dispatch("test-model", {
        cwd: tmpdir(),
        prompt: "hi",
        model: "gemini-3.8-flash-low",
        adapter,
      }),
    );
    expect(seen[0]?.model).toBe("gemini-3.8-flash-low");
  });

  it("leaves model unset when the caller does not supply one", () => {
    const { adapter, seen } = recordingAdapter();
    spawned.push(
      manager.dispatch("test-no-model", { cwd: tmpdir(), prompt: "hi", adapter }),
    );
    expect(seen[0]?.model).toBeUndefined();
  });
});
