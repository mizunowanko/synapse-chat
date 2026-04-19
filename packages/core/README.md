# @synapse-chat/core

Shared types and interfaces for the synapse-chat framework. Dependency-free — safe to import from Node.js, browsers, and bundlers.

> **Status**: Phase 4 — types stabilizing as more apps consume them. See [ADR-0026](../../../adr/0026-ai-chat-web-ui-framework.md).

## Exports

- `StreamMessage`, `StreamMessageType` — normalized shape of a single event streamed from a CLI.
- `ImageAttachment` — base64 image payload attached to a user message.
- `CLIAdapter` — interface every CLI backend implements (Claude, Gemini, …). See [the CLI adapter guide](../../docs/cli-adapter-guide.md).
- `SessionOptions` — input shape for launching a CLI session.
- `ProcessManagerLike`, `ProcessEvents`, `SendResult` — shared contract between the in-process `ProcessManager` (in `@synapse-chat/server`) and IPC proxies.

## Example

```ts
import type { CLIAdapter, StreamMessage } from "@synapse-chat/core";

const exampleAdapter: CLIAdapter = {
  command: "echo",
  buildArgs: (opts) => [opts.prompt ?? ""],
  parseOutput: (line): StreamMessage | null =>
    line ? { type: "assistant", content: line } : null,
  rateLimitPatterns: [/429/],
  retryableErrorPatterns: [/ECONNRESET/],
};
```

## License

MIT
