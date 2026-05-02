# @synapse-chat/react

React primitives for building AI chat UIs on top of `@synapse-chat/core` stream messages.

- `ChatMessage` — message bubble for user / assistant / tool_use / tool_result / error
- `ToolUseGroup` — collapsible wrapper for consecutive tool calls
- `SessionInput` — controlled textarea with image paste / drag-and-drop
- `useChat` — WebSocket connection + message accumulator
- `useWebSocket` — low-level hook wrapping `WSClient`
- `WSClient` — generic WebSocket client with backoff + optional ping/pong

## Install

```bash
pnpm add @synapse-chat/react @synapse-chat/core
# peer deps
pnpm add react react-dom
```

## Styling

The components use Tailwind utility classes that expect shadcn/ui-compatible
CSS variables to be defined on the consuming app:

- `bg-primary`, `text-primary-foreground`
- `bg-card`, `text-card-foreground`
- `bg-muted`, `text-muted-foreground`
- `bg-destructive`, `text-destructive-foreground`
- `border-border`, `border-input`, `ring-ring`
- `bg-accent`, `text-accent-foreground`

If your project already uses shadcn/ui (or sets up equivalent tokens) the
components will pick up your theme automatically. Without these tokens the
components still work but fall back to Tailwind defaults.

## Usage

```tsx
import {
  ChatMessage,
  SessionInput,
  useChat,
  type StreamMessage,
} from "@synapse-chat/react";

function App() {
  const [draft, setDraft] = useState("");
  const { messages, sendMessage, isConnected } = useChat<MyServerMsg>({
    wsOptions: { url: "ws://localhost:9721/ws" },
    decode: (raw) => (raw.type === "stream" ? raw.message : null),
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <ChatMessage key={msg.timestamp ?? i} message={msg} />
      ))}
      <SessionInput
        value={draft}
        onChange={setDraft}
        onSend={(text, images) => sendMessage(text, images)}
        disabled={!isConnected}
      />
    </div>
  );
}
```

### Extending ChatMessage

The generic `ChatMessage` renders `system` messages as `null`. Apps that want
to surface specific system subtypes (e.g. status badges, log entries) pass a
`renderSystem` or `renderMeta` callback:

```tsx
<ChatMessage
  message={msg}
  renderSystem={(m) =>
    m.subtype === "status" ? <Badge text={m.content ?? ""} /> : null
  }
  renderMeta={(m) =>
    m.meta?.category === "log" ? <LogLine content={m.content} /> : null
  }
/>
```

## Pitfalls

### Don't pair `useChat` with a separate `useWebSocket` for the same URL

`useChat` already calls `useWebSocket` internally. Each `useWebSocket`
instantiates its own `WSClient`, so this opens **two** sockets to the same
server from a single component:

```tsx
// ❌ Two sockets — useChat + useWebSocket each create a WSClient
function App() {
  const { sendMessage, messages } = useChat({ wsOptions: { url } });
  const { send } = useWebSocket({ url }); // ← second connection
  // ...
}
```

If you need to send arbitrary client messages (control frames like
`{ type: "app:reset" }`, custom commands, etc.) alongside chat traffic, use
the `client` returned by `useChat`:

```tsx
// ✅ One socket — reuse the client useChat already owns
function App() {
  const { sendMessage, messages, client } = useChat({ wsOptions: { url } });

  const reset = () => client.send({ type: "app:reset" });
  // ...
}
```

`client` is the same `WSClient` instance `useChat` uses internally and is
stable across renders, so you can also call `client.onMessage(...)` to
subscribe to raw frames `decode` chose to ignore.

## License

MIT
