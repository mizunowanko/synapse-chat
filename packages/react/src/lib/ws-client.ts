/**
 * Lightweight WebSocket client with exponential backoff reconnection and
 * optional ping/pong idle detection.
 *
 * Generic over the server message (`TServer`) and client message (`TClient`)
 * shapes so consuming apps can use their own protocol types without casting.
 */

type MessageHandler<T> = (msg: T) => void;
type ConnectHandler = () => void;

/**
 * Lifecycle phase reported by {@link WSClient.status} and the
 * {@link WSClient.onStatusChange} subscription.
 *
 * - `disconnected`: the client is idle. Either it has never been connected,
 *   or `disconnect()` was called explicitly. No reconnect timer is pending.
 * - `reconnecting`: a connection attempt is in progress, or a reconnect timer
 *   is scheduled after a drop. Used for both the initial connect attempt and
 *   subsequent reconnects so consumers can render a single "trying…" state.
 * - `connected`: the underlying socket is open.
 */
export type ConnectionStatus = "disconnected" | "reconnecting" | "connected";

type StatusHandler = (status: ConnectionStatus) => void;

export interface WSClientLogger {
  log?: (msg: string) => void;
  warn?: (msg: string, ...rest: unknown[]) => void;
  error?: (msg: string, ...rest: unknown[]) => void;
}

/**
 * Constructor options for {@link WSClient}.
 *
 * Note: this interface is generic over `TServer` (the server → client message
 * shape) even though the parameter is not used in any field. It acts as a
 * marker so `new WSClient(options)` can infer both type parameters at once.
 * TypeScript would normally flag the unused parameter; we reference it in
 * the optional `parseMessage` hook so every consumer can override the
 * decoder without losing inference.
 */
export interface WSClientOptions<TServer, TClient> {
  /**
   * WebSocket URL to connect to. Pass a factory function if the URL depends
   * on `window.location` (it is evaluated at connect time, so it works with
   * SSR and test environments).
   */
  url: string | (() => string);
  /**
   * If set, incoming messages whose `type` matches this value are treated as
   * keep-alive pings. The client replies with `pongMessage` and resets the
   * idle timeout. Set to `null` to disable ping handling entirely.
   */
  pingType?: string | null;
  /**
   * Payload sent back in response to a ping. Defaults to `{ type: "pong" }`.
   * Only used when `pingType` is set.
   */
  pongMessage?: TClient;
  /** Initial reconnection delay in ms. Default `1000`. */
  backoffBaseMs?: number;
  /** Maximum reconnection delay in ms. Default `30000`. */
  backoffMaxMs?: number;
  /**
   * If no ping is received within this period, the underlying socket is
   * closed (which then triggers reconnection). Default `45000` (1.5x the
   * typical 30s server ping interval). Set to `null` to disable.
   */
  idleTimeoutMs?: number | null;
  /** Optional logger. When omitted, messages go to `console`. */
  logger?: WSClientLogger;
  /**
   * Decode incoming socket text into `TServer`. Defaults to `JSON.parse`.
   * Apps with non-JSON framing (e.g. protobuf) override this. Returning
   * `undefined` drops the message silently.
   */
  parseMessage?: (raw: string) => TServer | undefined;
}

const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

/** Compute `ws(s)://<host>/ws` from `window.location`. Browser only. */
export function defaultWsUrl(path = "/ws"): string {
  if (typeof window === "undefined" || !window.location) {
    throw new Error(
      "defaultWsUrl() requires a browser window. Pass an explicit url to WSClient in non-browser contexts.",
    );
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

export class WSClient<TServer = unknown, TClient = unknown> {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler<TServer>>();
  private connectHandlers = new Set<ConnectHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _status: ConnectionStatus = "disconnected";
  private reconnectAttempt = 0;

  private readonly resolveUrl: () => string;
  private readonly pingType: string | null;
  private readonly pongMessage: TClient;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly idleTimeoutMs: number | null;
  private readonly logger: Required<WSClientLogger>;
  private readonly parseMessage: (raw: string) => TServer | undefined;

  constructor(options: WSClientOptions<TServer, TClient>) {
    this.resolveUrl =
      typeof options.url === "function" ? options.url : () => options.url as string;
    this.pingType = options.pingType === undefined ? "ping" : options.pingType;
    this.pongMessage =
      options.pongMessage ?? ({ type: "pong" } as unknown as TClient);
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.idleTimeoutMs =
      options.idleTimeoutMs === undefined
        ? DEFAULT_IDLE_TIMEOUT_MS
        : options.idleTimeoutMs;
    this.parseMessage =
      options.parseMessage ?? ((raw: string) => JSON.parse(raw) as TServer);
    this.logger = {
      log: options.logger?.log ?? ((msg: string) => console.log(msg)),
      warn:
        options.logger?.warn ??
        ((msg: string, ...rest: unknown[]) => console.warn(msg, ...rest)),
      error:
        options.logger?.error ??
        ((msg: string, ...rest: unknown[]) => console.error(msg, ...rest)),
    };
  }

  get connected(): boolean {
    return this._status === "connected";
  }

  /** Current lifecycle phase. See {@link ConnectionStatus}. */
  get status(): ConnectionStatus {
    return this._status;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    // Entering the attempt — surface "trying" state immediately so consumers
    // can render reconnect feedback without waiting for the first onopen/onclose.
    this.setStatus("reconnecting");

    try {
      this.ws = new WebSocket(this.resolveUrl());

      this.ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.logger.log("WSClient: connected");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.setStatus("connected");
        this.resetPingTimeout();
        for (const handler of this.connectHandlers) handler();
      };

      this.ws.onmessage = (event) => {
        let msg: TServer | undefined;
        try {
          msg = this.parseMessage(event.data as string);
        } catch (err) {
          this.logger.error("WSClient: failed to parse message", err);
          return;
        }
        if (msg === undefined) return;
        if (
          this.pingType !== null &&
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: unknown }).type === this.pingType
        ) {
          this.send(this.pongMessage);
          this.resetPingTimeout();
          return;
        }
        for (const handler of this.handlers) handler(msg);
      };

      this.ws.onclose = () => {
        this.clearPingTimeout();
        this.logger.log("WSClient: disconnected");
        // setStatus is folded into scheduleReconnect so we always reflect
        // the next attempt rather than briefly flickering to "disconnected".
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // Don't flip to "disconnected" here — onclose follows for any real
        // failure and will schedule a reconnect, which is the source of truth
        // for the status. Treating onerror as terminal would cause a flicker.
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearPingTimeout();
    if (this.ws) {
      // Detach handlers before close() so the synchronous onclose dispatch
      // doesn't re-enter scheduleReconnect — disconnect() is "stop and stay
      // stopped", not "drop and try again".
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
    }
    this.ws = null;
    this.reconnectAttempt = 0;
    this.setStatus("disconnected");
  }

  /**
   * Serialize and write `msg` to the underlying socket.
   *
   * Returns `true` when the payload was handed off to the socket, `false`
   * when the socket is not open (the caller can then queue it for later).
   * The return value is the only signal callers get — write failures after
   * the socket accepts the payload surface via `onclose`/`onerror`.
   */
  send(msg: TClient): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.logger.warn("WSClient: not connected, message dropped", msg);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  onMessage(handler: MessageHandler<TServer>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onConnect(handler: ConnectHandler): () => void {
    this.connectHandlers.add(handler);
    return () => {
      this.connectHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to lifecycle changes. The handler fires with the new
   * {@link ConnectionStatus} every time it transitions; identical-status
   * notifications are suppressed.
   */
  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private setStatus(next: ConnectionStatus): void {
    if (this._status === next) return;
    this._status = next;
    for (const handler of this.statusHandlers) handler(next);
  }

  private scheduleReconnect(): void {
    // Always reflect "trying to come back" — even if a timer is already armed
    // (the previous status may have been "connected" right before onclose).
    this.setStatus("reconnecting");
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.backoffBaseMs * Math.pow(2, this.reconnectAttempt),
      this.backoffMaxMs,
    );
    this.logger.log(
      `WSClient: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.connect();
    }, delay);
  }

  private resetPingTimeout(): void {
    if (this.idleTimeoutMs === null) return;
    this.clearPingTimeout();
    this.pingTimeoutTimer = setTimeout(() => {
      this.logger.log("WSClient: ping timeout — closing connection");
      this.ws?.close();
    }, this.idleTimeoutMs);
  }

  private clearPingTimeout(): void {
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = null;
    }
  }
}
