import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WSClient, type ConnectionStatus } from "./ws-client.js";

// ── Minimal WebSocket mock ────────────────────────────────────────────────
// jsdom does not expose a usable WebSocket; we replace the global with a
// hand-rolled fake that lets each test drive open/close/message manually.

type Listener = ((event: unknown) => void) | null;

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  // Test helpers — invoked by tests, not the SUT.
  fireOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  fireMessage(data: string): void {
    this.onmessage?.({ data });
  }

  fireClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }
}

const instances: MockWebSocket[] = [];

beforeEach(() => {
  instances.length = 0;
  vi.useFakeTimers();
  // The real WebSocket constants are read by ws-client (`WebSocket.OPEN`).
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe("WSClient — connection status lifecycle", () => {
  it("starts in 'disconnected' and transitions through 'reconnecting' → 'connected' on connect()", () => {
    const client = new WSClient({ url: "ws://test", logger: silentLogger });
    const seen: ConnectionStatus[] = [];
    client.onStatusChange((s) => seen.push(s));

    expect(client.status).toBe("disconnected");

    client.connect();
    expect(client.status).toBe("reconnecting");

    instances[0]!.fireOpen();
    expect(client.status).toBe("connected");
    expect(client.connected).toBe(true);

    expect(seen).toEqual(["reconnecting", "connected"]);
  });

  it("transitions back to 'reconnecting' after onclose and arms a reconnect timer", () => {
    const client = new WSClient({
      url: "ws://test",
      backoffBaseMs: 100,
      backoffMaxMs: 1000,
      idleTimeoutMs: null,
      logger: silentLogger,
    });
    client.connect();
    instances[0]!.fireOpen();
    expect(client.status).toBe("connected");

    instances[0]!.fireClose();
    expect(client.status).toBe("reconnecting");
    expect(client.connected).toBe(false);

    // Advance to the scheduled reconnect attempt — a new socket is created.
    vi.advanceTimersByTime(100);
    expect(instances).toHaveLength(2);

    instances[1]!.fireOpen();
    expect(client.status).toBe("connected");
  });

  it("disconnect() clears timers and surfaces 'disconnected'", () => {
    const client = new WSClient({
      url: "ws://test",
      backoffBaseMs: 100,
      idleTimeoutMs: null,
      logger: silentLogger,
    });
    const seen: ConnectionStatus[] = [];
    client.onStatusChange((s) => seen.push(s));

    client.connect();
    instances[0]!.fireOpen();
    instances[0]!.fireClose();
    expect(client.status).toBe("reconnecting");

    client.disconnect();
    expect(client.status).toBe("disconnected");

    // Timer should be cancelled — no new socket is created after the delay.
    vi.advanceTimersByTime(5_000);
    expect(instances).toHaveLength(1);

    expect(seen).toEqual([
      "reconnecting",
      "connected",
      "reconnecting",
      "disconnected",
    ]);
  });

  it("does not fire onStatusChange for identical-status updates", () => {
    const client = new WSClient({
      url: "ws://test",
      backoffBaseMs: 100,
      idleTimeoutMs: null,
      logger: silentLogger,
    });
    const handler = vi.fn();
    client.onStatusChange(handler);

    client.connect();
    instances[0]!.fireOpen();
    instances[0]!.fireClose();
    // While reconnecting, scheduleReconnect can be called repeatedly without
    // firing redundant transitions.
    expect(handler.mock.calls.map((c) => c[0])).toEqual([
      "reconnecting",
      "connected",
      "reconnecting",
    ]);
  });

  it("unsubscribe stops further notifications", () => {
    const client = new WSClient({
      url: "ws://test",
      idleTimeoutMs: null,
      logger: silentLogger,
    });
    const handler = vi.fn();
    const unsub = client.onStatusChange(handler);
    client.connect();
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    instances[0]!.fireOpen();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("WSClient — send return value", () => {
  it("returns true when the socket is open and false otherwise", () => {
    const client = new WSClient({
      url: "ws://test",
      idleTimeoutMs: null,
      logger: silentLogger,
    });

    expect(client.send({ hello: 1 })).toBe(false); // socket not created yet

    client.connect();
    expect(client.send({ hello: 1 })).toBe(false); // CONNECTING, not OPEN

    instances[0]!.fireOpen();
    expect(client.send({ hello: 2 })).toBe(true);
    expect(instances[0]!.sent).toEqual([JSON.stringify({ hello: 2 })]);
  });
});
