# @synapse-chat/mcp

MCP (Model Context Protocol) helpers for synapse-chat: turn an application's Backend HTTP API into a set of MCP tools that local CLI agents (Claude Code, Gemini CLI, …) can call directly.

## What's inside

| Export | Purpose |
| --- | --- |
| `defineHttpTool()` | Declarative description of a single Backend endpoint as an MCP tool. Validates name / method / path at authoring time. |
| `createMcpServer()` | Wire a set of tool definitions into an MCP stdio server in one call. Handles `tools/list` and `tools/call` requests against the MCP SDK. |
| `callHttpTool()` | Lower-level helper that substitutes path params, builds the request, and maps 4xx/5xx responses into MCP-shaped error results. |
| `prepareMcpWorkspace()` | Write the CLI-specific settings files (`.mcp.json` + `.claude/settings.local.json`, or `.gemini/settings.json`) to a worktree before spawning the CLI. |
| `generateGeminiSettings()` / `writeGeminiSettings()` | Pure / filesystem variants for Gemini CLI. |
| `generateClaudeSettings()` / `writeClaudeSettings()` | Pure / filesystem variants for Claude Code. |
| `deriveAllowedTools()` | Translate MCP tool definitions into a CLI allow-list (`mcp__<server>__<tool>` for Claude, `<server>__<tool>` for Gemini). |

## Quick look

```ts
// packages/backend/mcp-server.mjs
import { createMcpServer, defineHttpTool } from "@synapse-chat/mcp";

const tools = [
  defineHttpTool({
    name: "list_duties",
    description: "List every duty currently open.",
    method: "GET",
    path: "/api/duties",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" } },
    },
  }),
  defineHttpTool({
    name: "delete_duty",
    description: "Delete a duty. Destructive.",
    method: "DELETE",
    path: "/api/duties/{id}",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    confirmation: true,
  }),
];

const server = createMcpServer({
  name: "my-backend",
  version: "0.1.0",
  tools,
  baseUrl: process.env.BACKEND_BASE_URL,
});
await server.start();
```

```ts
// server.ts — spawn the CLI with the MCP server pre-wired
import { prepareMcpWorkspace } from "@synapse-chat/mcp";
import { spawn } from "node:child_process";

await prepareMcpWorkspace(worktreePath, {
  cli: "claude",
  mcpServers: {
    "my-backend": {
      command: "node",
      args: ["./mcp-server.mjs"],
      env: { BACKEND_BASE_URL: "http://localhost:8080" },
    },
  },
});

spawn("claude", ["-p", "List open duties"], { cwd: worktreePath });
```

See [`docs/mcp-helper-guide.md`](../../docs/mcp-helper-guide.md) for the full walkthrough.

## Skills server (`@synapse-chat/mcp/skills`, `synapse-skills`)

Agent skills (`SKILL.md` + attached files) kept in one SQLite file and handed to Claude Code / Codex / agy by a stdio MCP server started per CLI session. Tiers: everyone → agent → desk (the lower tier wins). The desk tier is keyed on the desk id (`--desk-id`, `deskId`, `deskViewer()`), so renaming a desk does not cut it off; rows an older app keyed on the desk's name are read beneath the id through `legacyDesk` (`--desk <name>`) until the app migrates them. Needs Node 22.13+ (`node:sqlite`).

```bash
synapse-skills import ./skills --global --db /abs/skills.db          # bring existing skill dirs in
synapse-skills import ./my-skills --agent Tsukuyo --db /abs/skills.db
synapse-skills list --agent Tsukuyo --db /abs/skills.db
synapse-skills register claude --agent Tsukuyo --db /abs/skills.db    # JSON for `claude --mcp-config`
```

```ts
import { claudeSkillsMcpConfig, codexSkillsConfigArgs, agySkillsPluginFiles, SKILLS_AGENTS_MD_GUIDANCE } from "@synapse-chat/mcp/skills";
```

Design, write rules and the per-CLI registration: [`docs/design/skills-mcp.md`](../../docs/design/skills-mcp.md).

## Instructions (`@synapse-chat/mcp/instructions`, `synapse-instructions`)

Agents' standing instructions (what used to be `CLAUDE.md` / `AGENTS.md`) kept in the same SQLite file as the skills, in two tiers: everyone and agent (the agent's text is appended after everyone's). They are always in context: each CLI gets the full text at launch, not a tool to fetch it with.

```bash
synapse-instructions import ./agents/CLAUDE.md --global --db /abs/skills.db
synapse-instructions import ./agents/Tsukuyo/CLAUDE.md --agent Tsukuyo --db /abs/skills.db
synapse-instructions show --agent Tsukuyo --effective --db /abs/skills.db
synapse-instructions launch claude --cwd /abs/agents/Tsukuyo --agent Tsukuyo --replace /abs/agents/Tsukuyo --db /abs/skills.db
# the output also carries the MCP server ledger under `mcp` (below); add --desk-id I [--desk <name>] for desk-tier servers
```

```ts
import { InstructionStore, effectiveInstructions, instructionsLaunch } from "@synapse-chat/mcp/instructions";
const { text } = effectiveInstructions(InstructionStore.open(db), "Tsukuyo");
const launch = instructionsLaunch("claude", { text, cwd, replaces: [cwd] }); // systemPromptAppend / args / files / stillLoaded
```

Per-CLI delivery and how the replaced files are kept out: [`docs/design/instructions.md`](../../docs/design/instructions.md).

## MCP server ledger (`@synapse-chat/mcp/mcp-servers`, `synapse-mcp-servers`)

The MCP servers an agent's sessions get, kept provider-neutral in the same SQLite file, in the skills' tiers (everyone → agent → desk; the lower tier wins a name, `enabled: false` switches a server off for that tier). Every write is a new version; removing leaves a tombstone. Secrets stay out of the DB: any value may say `${NAME}`, expanded at launch from the environment you pass (a missing variable skips that server and says which variable). A server that has a UI (an MCP App) carries `"ui": true` (or `put --ui`): the launch is the same, and the app finds those servers with `McpServerStore.listApps()` / `McpServerRecord.ui` (`list --ui` on the CLI).

```bash
cat > artiflow.json <<'JSON'
{"name": "artiflow", "transport": "stdio", "command": "node", "args": ["/srv/artiflow/mcp.js"],
 "env": {"ARTIFLOW_TOKEN": "${ARTIFLOW_TOKEN}"}, "cwd": "/srv/artiflow"}
JSON
synapse-mcp-servers put artiflow.json --agent Homura --db /abs/skills.db
synapse-mcp-servers list --effective --agent Homura --desk-id <desk id> --desk artiflow --db /abs/skills.db
synapse-mcp-servers launch codex --agent Homura --db /abs/skills.db   # what Codex would get (secrets expanded)
synapse-mcp-servers history artiflow --db /abs/skills.db
synapse-mcp-servers put cards.json --global --ui --db /abs/skills.db   # an MCP App (a server with a UI)
synapse-mcp-servers list --ui --db /abs/skills.db
```

```ts
import { McpServerStore, mcpServersLaunch, claudeMcpConfigArgs } from "@synapse-chat/mcp/mcp-servers";
const ledger = McpServerStore.open(db).effective(deskViewer("Homura", deskId, deskName)); // deskName: legacy rows only
const mcp = mcpServersLaunch(cli, ledger, { env: process.env, reserved: ["skills", ...yourOwnNames] });
// claude: claudeMcpConfigArgs(yourServers, mcp.mcpServers) → one --mcp-config
// codex:  [...yourArgs, ...mcp.args]          (-c mcp_servers.<name>.…)
// agy:    write mcp.files under the cwd       (.agents/plugins/synapse-mcp-servers/)
// mcp.skipped / mcp.disabled: what was not handed out, and why
```

Per-CLI delivery (Claude ignores a stdio `cwd`, so it is started through `/bin/sh`; Codex's TOML quoting; agy's plugin and its withdrawal) and how to merge with your own servers: [`docs/design/mcp-servers.md`](../../docs/design/mcp-servers.md).

## Peers (`@synapse-chat/mcp/peers`, `synapse-peers`)

A stdio MCP server, one per CLI session, that lets the session message the app's other sessions: `list_peers` and `send_message`, relayed to two HTTP endpoints the app implements (`GET /api/peers`, `POST /api/peers/messages`; the types are in `contract.ts`). The app owns addresses, delivery, limits and the sender's identity, which it reads from the bearer token in the server's launch arguments (never an environment variable). The server passes the app's refusals (`reason` and all) to the model and makes up only `server-unreachable`. No `node:sqlite`, so Node 20 is enough.

```ts
import { claudeMcpConfigArgs } from "@synapse-chat/mcp/mcp-servers";
import { claudePeersMcpServers, codexPeersConfigArgs, agyPeersPluginFiles, withdrawPeersFiles } from "@synapse-chat/mcp/peers";
const peers = { api: "http://127.0.0.1:8001", token }; // one token per session
// claude: claudeMcpConfigArgs(claudePeersMcpServers(peers), yourServers) → one --mcp-config
// codex:  [...codexPeersConfigArgs(peers), ...yourArgs]
// agy:    write agyPeersPluginFiles(peers) under the cwd (.agents/plugins/synapse-peers/, 0600: it holds the token)
//         withdrawPeersFiles("agy") over an existing plugin to take it back
```

```bash
synapse-peers register claude --api http://127.0.0.1:8123 --token t --log /abs/peers.jsonl   # what Claude would get
```

The contract, the annotations, per-CLI measurements and traps (agy needs `--dangerously-skip-permissions`; two agy launches in one cwd can swap tokens): [`docs/design/peers-mcp.md`](../../docs/design/peers-mcp.md).

## Design notes

- **Input schemas are JSON Schema.** No Zod / TypeBox lock-in. The MCP SDK accepts JSON Schema verbatim, and this keeps the door open for OpenAPI → MCP generation.
- **Confirmation is first-class.** `confirmation: true` automatically injects a required `confirmed: boolean` property into the tool's input schema and short-circuits with an MCP error if missing.
- **Generators merge, they do not clobber.** Existing `.mcp.json` / `.gemini/settings.json` contents are preserved; only the `mcpServers` map and enablement flags are touched.
- **Transport.** Stdio only for MVP. The server handle exposes the underlying `Server` so callers who need SSE / HTTP transports can call `server.connect(...)` with their own transport.
