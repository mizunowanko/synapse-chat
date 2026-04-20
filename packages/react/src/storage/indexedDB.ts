import type { ChatStorage, StreamMessage } from "@synapse-chat/core";

export interface IndexedDBAdapterOptions {
  /** Database name. Defaults to `"synapse-chat"`. */
  dbName?: string;
  /** Object store name. Defaults to `"sessions"`. */
  storeName?: string;
  /** Database version. Defaults to `1`. Bump when altering the schema. */
  version?: number;
  /**
   * Override the IndexedDB factory. Defaults to `globalThis.indexedDB`.
   * Useful for tests (e.g. `fake-indexeddb`).
   */
  factory?: IDBFactory;
  /** Optional logger. Defaults to `console`. Pass `null` to silence. */
  logger?: Pick<Console, "warn"> | null;
}

interface Resolved {
  readonly factory: IDBFactory | null;
  readonly dbName: string;
  readonly storeName: string;
  readonly version: number;
  readonly warn: (msg: string, err?: unknown) => void;
}

function resolve(opts: IndexedDBAdapterOptions | undefined): Resolved {
  const dbName = opts?.dbName ?? "synapse-chat";
  const storeName = opts?.storeName ?? "sessions";
  const version = opts?.version ?? 1;
  const logger = opts?.logger === undefined ? console : opts.logger;
  const warn = (msg: string, err?: unknown): void => {
    if (logger) logger.warn(`[synapse-chat/indexedDBAdapter] ${msg}`, err);
  };

  let factory: IDBFactory | null = opts?.factory ?? null;
  if (factory === null && typeof globalThis !== "undefined") {
    const g = globalThis as { indexedDB?: IDBFactory };
    factory = g.indexedDB ?? null;
  }
  return { factory, dbName, storeName, version, warn };
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDBRequest failed"));
  });
}

function openDb(r: Resolved): Promise<IDBDatabase> {
  if (!r.factory) {
    return Promise.reject(new Error("indexedDB is not available"));
  }
  return new Promise((resolve, reject) => {
    // Non-null assertion is safe because of the guard above; TS can't infer it
    // through the closure without help.
    const open = r.factory!.open(r.dbName, r.version);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(r.storeName)) {
        db.createObjectStore(r.storeName);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("open failed"));
    open.onblocked = () => reject(new Error("open blocked"));
  });
}

async function withStore<R>(
  r: Resolved,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<R>,
): Promise<R> {
  const db = await openDb(r);
  try {
    const tx = db.transaction(r.storeName, mode);
    const store = tx.objectStore(r.storeName);
    const result = await fn(store);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    });
    return result;
  } finally {
    db.close();
  }
}

/**
 * Create a {@link ChatStorage} backed by IndexedDB.
 *
 * Suitable for larger chat histories (tens of MB) where Web Storage quotas
 * become limiting. Each session is stored as a single record keyed by
 * `sessionId` inside one object store.
 *
 * - SSR-safe: returns a no-op adapter when `indexedDB` is unavailable.
 * - Errors during `save` / `clear` are swallowed and logged so a transient
 *   IDB failure does not break the UI; `load` errors return `null`.
 */
export function createIndexedDBAdapter<T = StreamMessage>(
  options?: IndexedDBAdapterOptions,
): ChatStorage<T> {
  const resolved = resolve(options);
  const { factory, warn } = resolved;

  if (!factory) {
    return {
      async save() {},
      async load() {
        return null;
      },
      async clear() {},
    };
  }

  return {
    async save(sessionId, messages) {
      try {
        await withStore(resolved, "readwrite", async (store) => {
          // Clone to a plain array — some IDB impls reject readonly arrays.
          await requestToPromise(store.put([...messages], sessionId));
        });
      } catch (err) {
        warn(`save failed for session ${sessionId}`, err);
      }
    },

    async load(sessionId) {
      try {
        return await withStore(resolved, "readonly", async (store) => {
          const raw = (await requestToPromise(store.get(sessionId))) as unknown;
          if (raw === undefined) return null;
          if (!Array.isArray(raw)) {
            warn(`load found non-array payload for session ${sessionId}; discarding`);
            return null;
          }
          return raw as T[];
        });
      } catch (err) {
        warn(`load failed for session ${sessionId}`, err);
        return null;
      }
    },

    async clear(sessionId) {
      try {
        await withStore(resolved, "readwrite", async (store) => {
          await requestToPromise(store.delete(sessionId));
        });
      } catch (err) {
        warn(`clear failed for session ${sessionId}`, err);
      }
    },
  };
}
