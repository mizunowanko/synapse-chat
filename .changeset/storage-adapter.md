---
"@synapse-chat/core": minor
"@synapse-chat/react": minor
---

feat: add Chat Storage Adapter pattern for history persistence

- `@synapse-chat/core` exports a new `ChatStorage<T>` interface (`save` / `load` / `clear`).
- `@synapse-chat/react/storage` ships two opt-in adapters: `createLocalStorageAdapter` and `createIndexedDBAdapter`. Both are SSR-safe (no-op when the underlying browser API is missing).
- `useChat` accepts `storage` + `sessionId` options, hydrates on mount, debounces writes, and exposes `isHydrating`. Without those options the hook behaves exactly as before.
