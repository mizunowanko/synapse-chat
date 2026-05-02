---
"@synapse-chat/react": minor
---

feat(react): expose underlying `WSClient` from `useChat`

`useChat` now returns a `client` field — the same `WSClient` instance the hook uses internally. Use it to send arbitrary control messages (e.g. `{ type: "app:reset" }`) without spinning up a second `useWebSocket`, which would open a duplicate socket from the same component.

```tsx
const { sendMessage, messages, client } = useChat({ wsOptions: { url } });
const reset = () => client.send({ type: "app:reset" });
```

The `UseChatResult` type is now generic over `<TServer, TClient>` to type the exposed `client`. Existing call sites that don't reference `client` are unaffected.
