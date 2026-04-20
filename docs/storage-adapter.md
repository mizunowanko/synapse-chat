# Chat Storage Adapters

`useChat` ships as a thin primitive and does not persist history by default. To survive reloads, pass a `ChatStorage` adapter plus a stable `sessionId`:

```tsx
import { useChat } from "@synapse-chat/react";
import { createLocalStorageAdapter } from "@synapse-chat/react/storage";

const storage = createLocalStorageAdapter();

function Chat({ sessionId }: { sessionId: string }) {
  const { messages, isHydrating, sendMessage, clear } = useChat({
    wsOptions: { url: "ws://localhost:3000/ws" },
    decode: (raw) => raw as never,
    storage,
    sessionId,
  });

  if (isHydrating) return <div>Loading history…</div>;
  // …
}
```

Adapter construction is opt-in and lives in a dedicated subpath (`@synapse-chat/react/storage`) so it tree-shakes away when unused.

## The `ChatStorage` contract

```ts
export interface ChatStorage<T = StreamMessage> {
  save(sessionId: string, messages: readonly T[]): Promise<void>;
  load(sessionId: string): Promise<T[] | null>;
  clear(sessionId: string): Promise<void>;
}
```

- `load` returns `null` when the session has no entry, and an empty array when the session exists but is empty. `useChat` uses that distinction to decide whether to fall back to `initialMessages`.
- `clear` is idempotent — removing a missing entry must not throw.
- All methods may be called concurrently; adapters serialize internally if their backend requires it.

The interface is deliberately minimal. Extend it in your own types if you need listing / metadata / eviction.

## Built-in adapters

Both shipped adapters are SSR-safe: when the required browser API is not available, every method is a silent no-op. This means you can drop them in during server rendering without guarding with `typeof window`.

### `createLocalStorageAdapter`

```ts
createLocalStorageAdapter({
  keyPrefix?: string;   // default "synapse-chat:"
  storage?: Storage;    // override (e.g. sessionStorage)
  logger?: Pick<Console, "warn"> | null;
});
```

- Serializes via `JSON.stringify`. Parse failures on `load` return `null` so a corrupted entry does not break the UI.
- Quota errors on `save` are swallowed and logged.
- Best fit for short histories (Web Storage caps around 5 MB per origin).

### `createIndexedDBAdapter`

```ts
createIndexedDBAdapter({
  dbName?: string;      // default "synapse-chat"
  storeName?: string;   // default "sessions"
  version?: number;     // default 1
  factory?: IDBFactory; // test override (e.g. fake-indexeddb)
  logger?: Pick<Console, "warn"> | null;
});
```

- Each session is one record keyed by `sessionId` in a single object store.
- Suitable for large histories (tens of MB).
- `save` / `clear` errors are swallowed and logged; `load` errors return `null`.

## When to pick which

| Concern | `localStorage` | IndexedDB |
|---|---|---|
| Typical quota | ~5 MB | Hundreds of MB |
| Sync vs async | Sync under the hood | Async |
| Browser support | Universal | Universal, slightly more moving parts |
| Good for | Small chat logs, settings | Long sessions, many attachments |

Pick `localStorage` unless you can already see the histories growing past a few MB.

## Hydration & race conditions

`useChat`'s persistence logic is intentionally conservative. Specifically:

- `isHydrating` is `true` from mount until `storage.load(sessionId)` resolves the first time. Guard your UI with it (e.g. show a skeleton) so users don't see the empty initial state flash before real data arrives.
- No `storage.save` call is made before hydration completes. That prevents the initial empty state from overwriting persisted data if rendering beats the load.
- When `sessionId` changes, the hook loads the new session. A load already in flight for the previous session is cancelled — its result (if any) is discarded rather than being mistakenly applied to the new session's messages.
- Writes are debounced (`saveDebounceMs`, default `200 ms`). Rapid stream updates coalesce into a single write.
- `clear()` clears both the in-memory messages and the stored entry.

Operations that finish after the component unmounts still complete so that in-flight writes are not lost. Their results simply don't update React state.

## Writing a custom adapter

Any object satisfying `ChatStorage` works. Some patterns:

```ts
// Remote server (e.g. you already have a /history endpoint).
const remoteAdapter: ChatStorage = {
  async save(sessionId, messages) {
    await fetch(`/history/${sessionId}`, {
      method: "PUT",
      body: JSON.stringify(messages),
    });
  },
  async load(sessionId) {
    const res = await fetch(`/history/${sessionId}`);
    if (res.status === 404) return null;
    return (await res.json()) as StreamMessage[];
  },
  async clear(sessionId) {
    await fetch(`/history/${sessionId}`, { method: "DELETE" });
  },
};
```

```ts
// React Native (wraps AsyncStorage).
import AsyncStorage from "@react-native-async-storage/async-storage";

const rnAdapter: ChatStorage = {
  async save(id, messages) {
    await AsyncStorage.setItem(`chat/${id}`, JSON.stringify(messages));
  },
  async load(id) {
    const raw = await AsyncStorage.getItem(`chat/${id}`);
    return raw ? (JSON.parse(raw) as StreamMessage[]) : null;
  },
  async clear(id) {
    await AsyncStorage.removeItem(`chat/${id}`);
  },
};
```

If you need listing, metadata, or versioning, extend the interface in your own type — it is additive and will not conflict with future library changes as long as `save` / `load` / `clear` keep their current shape.
