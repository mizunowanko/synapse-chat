import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "@synapse-chat/core";
import { createLocalStorageAdapter } from "./localStorage.js";

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
}

const msgs: StreamMessage[] = [
  { type: "user", content: "hi" },
  { type: "assistant", content: "hello" },
];

describe("createLocalStorageAdapter", () => {
  let backing: Storage;

  beforeEach(() => {
    backing = makeStorage();
  });

  it("round-trips save / load / clear", async () => {
    const adapter = createLocalStorageAdapter({ storage: backing, logger: null });
    expect(await adapter.load("s1")).toBeNull();

    await adapter.save("s1", msgs);
    expect(await adapter.load("s1")).toEqual(msgs);

    await adapter.clear("s1");
    expect(await adapter.load("s1")).toBeNull();
  });

  it("scopes keys with the provided prefix", async () => {
    const adapter = createLocalStorageAdapter({
      storage: backing,
      keyPrefix: "custom/",
      logger: null,
    });
    await adapter.save("s1", msgs);
    expect(backing.getItem("custom/s1")).not.toBeNull();
    expect(backing.getItem("synapse-chat:s1")).toBeNull();
  });

  it("returns null (not throw) on corrupted JSON", async () => {
    backing.setItem("synapse-chat:s1", "not-json");
    const logger = { warn: vi.fn() };
    const adapter = createLocalStorageAdapter({ storage: backing, logger });
    expect(await adapter.load("s1")).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("discards non-array payloads", async () => {
    backing.setItem("synapse-chat:s1", JSON.stringify({ type: "user" }));
    const adapter = createLocalStorageAdapter({ storage: backing, logger: null });
    expect(await adapter.load("s1")).toBeNull();
  });

  it("is a no-op when no Storage is available", async () => {
    const originalLocalStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: undefined,
    });
    try {
      const adapter = createLocalStorageAdapter({ logger: null });
      await expect(adapter.save("s1", msgs)).resolves.toBeUndefined();
      expect(await adapter.load("s1")).toBeNull();
      await expect(adapter.clear("s1")).resolves.toBeUndefined();
    } finally {
      if (originalLocalStorage) {
        Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });

  it("swallows setItem errors (e.g. quota) and warns", async () => {
    const throwing: Storage = {
      ...makeStorage(),
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    const logger = { warn: vi.fn() };
    const adapter = createLocalStorageAdapter({ storage: throwing, logger });
    await expect(adapter.save("s1", msgs)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
