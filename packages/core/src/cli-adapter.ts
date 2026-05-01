import type { StreamMessage } from "./types.js";

/**
 * Options passed when spawning a CLI session.
 *
 * Fields map to the common surface area of AI CLIs (Claude Code, Gemini CLI,
 * …). Adapter implementations translate these into CLI-specific flags via
 * {@link CLIAdapter.buildArgs}.
 */
export interface SessionOptions {
  prompt?: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Auto-approve all tool/permission prompts. Translates to CLI-specific flags:
   * - Claude: `--dangerously-skip-permissions`
   * - Gemini: `--yolo`
   *
   * Intended for non-interactive automated dispatches (e.g. background workers).
   * Leave unset for interactive chat sessions where a human should approve.
   */
  autoApprove?: boolean;
}

/**
 * Contract for a CLI backend. Each supported CLI (Claude, Gemini, …) ships an
 * adapter implementing this interface; the server package then spawns and
 * streams processes through it without knowing CLI-specific details.
 */
export interface CLIAdapter {
  /** Executable name or absolute path of the CLI binary. */
  readonly command: string;

  /** Translate generic session options into CLI-specific argv. */
  buildArgs(options: SessionOptions): string[];

  /** Parse a single stdout line into a StreamMessage, or `null` to skip. */
  parseOutput(line: string): StreamMessage | null;

  /** Format a user message for stdin (optional — only needed for interactive CLIs). */
  formatInput?(message: string): string;

  /** Patterns that indicate a rate-limit error in stderr. */
  rateLimitPatterns: RegExp[];

  /** Patterns that indicate a transient error worth retrying. */
  retryableErrorPatterns: RegExp[];
}
