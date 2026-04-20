import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { StreamMessage } from "@synapse-chat/core";
import { createIndexedDBAdapter } from "./indexedDB.js";

const msgs: StreamMessage[] = [
  { type: "user", content: "hi" },
  { type: "assistant", content: "hello" },
];

describe("createIndexedDBAdapter", () => {
  let factory: IDBFactory;

  beforeEach(() => {
    factory = new IDBFactory();
  });

  it("round-trips save / load / clear", async () => {
    const adapter = createIndexedDBAdapter({ factory, logger: null });
    expect(await adapter.load("s1")).toBeNull();

    await adapter.save("s1", msgs);
    expect(await adapter.load("s1")).toEqual(msgs);

    await adapter.clear("s1");
    expect(await adapter.load("s1")).toBeNull();
  });

  it("keeps sessions isolated", async () => {
    const adapter = createIndexedDBAdapter({ factory, logger: null });
    await adapter.save("s1", msgs);
    await adapter.save("s2", [{ type: "system", content: "other" }]);

    expect(await adapter.load("s1")).toEqual(msgs);
    expect(await adapter.load("s2")).toEqual([{ type: "system", content: "other" }]);
  });

  it("is a no-op when IndexedDB is unavailable", async () => {
    const originalIdb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
    try {
      const adapter = createIndexedDBAdapter({ logger: null });
      await expect(adapter.save("s1", msgs)).resolves.toBeUndefined();
      expect(await adapter.load("s1")).toBeNull();
      await expect(adapter.clear("s1")).resolves.toBeUndefined();
    } finally {
      if (originalIdb) {
        Object.defineProperty(globalThis, "indexedDB", originalIdb);
      } else {
        delete (globalThis as { indexedDB?: unknown }).indexedDB;
      }
    }
  });
});
