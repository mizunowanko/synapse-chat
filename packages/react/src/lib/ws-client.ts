/**
 * Lightweight WebSocket client with exponential backoff reconnection and
 * optional ping/pong idle detection.
 *
 * Generic over the server message (`TServer`) and client message (`TClient`)
 * shapes so consuming apps can use their own protocol types without casting.
 */

type MessageHandler<T> = (msg: T) => void;
type ConnectHandler = () => void;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
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
    return this._connected;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(this.resolveUrl());

      this.ws.onopen = () => {
        this._connected = true;
        this.reconnectAttempt = 0;
        this.logger.log("WSClient: connected");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
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
        this._connected = false;
        this.clearPingTimeout();
        this.logger.log("WSClient: disconnected");
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this._connected = false;
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
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this.reconnectAttempt = 0;
  }

  send(msg: TClient): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.logger.warn("WSClient: not connected, message dropped", msg);
      return;
    }
    this.ws.send(JSON.stringify(msg));
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

  private scheduleReconnect(): void {
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
