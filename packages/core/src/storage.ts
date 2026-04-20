/**
 * Persistence contract for chat histories.
 *
 * Only interfaces live here — concrete adapters (localStorage, IndexedDB, ...)
 * ship from `@synapse-chat/react/storage` and other environment-specific
 * entry points. This split keeps the core package free of browser / DOM
 * dependencies so it remains usable in SSR, workers, and React Native.
 *
 * See {@link ChatStorage} for the shape every adapter satisfies.
 */

import type { StreamMessage } from "./types.js";

/**
 * Session-addressed persistence for a list of chat messages.
 *
 * The interface is intentionally minimal (save / load / clear). Listing,
 * metadata, or multi-session enumeration are left to adapter extensions so
 * that constrained environments (e.g. a fixed single-session store) do not
 * have to stub them out.
 *
 * Contract:
 * - `save` persists the full current list; callers do not receive deltas.
 * - `load` returns `null` when no entry exists, empty array when the entry is
 *   empty. Distinguishing the two lets consumers decide whether to fall back
 *   to an `initialMessages` seed.
 * - `clear` is idempotent — removing a missing entry must not throw.
 * - All methods may be called concurrently. Adapters should serialize writes
 *   internally if their backend requires it.
 */
export interface ChatStorage<T = StreamMessage> {
  save(sessionId: string, messages: readonly T[]): Promise<void>;
  load(sessionId: string): Promise<T[] | null>;
  clear(sessionId: string): Promise<void>;
}
