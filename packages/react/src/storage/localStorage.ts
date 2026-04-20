import type { ChatStorage, StreamMessage } from "@synapse-chat/core";

export interface LocalStorageAdapterOptions {
  /** Prefix applied to every key. Defaults to `"synapse-chat:"`. */
  keyPrefix?: string;
  /**
   * Override the storage object. Defaults to `globalThis.localStorage`.
   * Useful for tests or to scope to `sessionStorage`.
   */
  storage?: Storage;
  /** Optional logger. Defaults to `console`. Pass `null` to silence. */
  logger?: Pick<Console, "warn"> | null;
}

interface ResolvedStorage {
  /**
   * `null` means the environment has no usable Web Storage. In that case the
   * adapter becomes a silent no-op so SSR / worker callers don't crash.
   */
  readonly backing: Storage | null;
  readonly prefix: string;
  readonly warn: (msg: string, err?: unknown) => void;
}

function resolve(opts: LocalStorageAdapterOptions | undefined): ResolvedStorage {
  const prefix = opts?.keyPrefix ?? "synapse-chat:";
  const logger = opts?.logger === undefined ? console : opts.logger;
  const warn = (msg: string, err?: unknown): void => {
    if (logger) logger.warn(`[synapse-chat/localStorageAdapter] ${msg}`, err);
  };

  let backing: Storage | null = opts?.storage ?? null;
  if (backing === null && typeof globalThis !== "undefined") {
    const g = globalThis as { localStorage?: Storage };
    backing = g.localStorage ?? null;
  }
  return { backing, prefix, warn };
}

/**
 * Create a {@link ChatStorage} backed by Web Storage (defaults to `localStorage`).
 *
 * - SSR-safe: returns a no-op adapter when `localStorage` is unavailable.
 * - Corruption-safe: `load` returns `null` on JSON parse failure rather than
 *   throwing, so a bad entry does not brick the chat UI.
 * - Bounded payloads only: callers are responsible for keeping histories under
 *   the browser's Web Storage quota (typically 5 MB). For larger histories use
 *   `createIndexedDBAdapter`.
 */
export function createLocalStorageAdapter<T = StreamMessage>(
  options?: LocalStorageAdapterOptions,
): ChatStorage<T> {
  const { backing, prefix, warn } = resolve(options);
  const key = (sessionId: string): string => `${prefix}${sessionId}`;

  return {
    async save(sessionId, messages) {
      if (!backing) return;
      try {
        backing.setItem(key(sessionId), JSON.stringify(messages));
      } catch (err) {
        warn(`save failed for session ${sessionId}`, err);
      }
    },

    async load(sessionId) {
      if (!backing) return null;
      const raw = backing.getItem(key(sessionId));
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) {
          warn(`load found non-array payload for session ${sessionId}; discarding`);
          return null;
        }
        return parsed as T[];
      } catch (err) {
        warn(`load failed to parse JSON for session ${sessionId}`, err);
        return null;
      }
    },

    async clear(sessionId) {
      if (!backing) return;
      try {
        backing.removeItem(key(sessionId));
      } catch (err) {
        warn(`clear failed for session ${sessionId}`, err);
      }
    },
  };
}
