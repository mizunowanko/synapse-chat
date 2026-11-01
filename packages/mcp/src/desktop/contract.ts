/**
 * The two contracts of the desktop MCP server (docs/design/desktop-mcp.md).
 *
 * 1. **The approval API**, which the app implements. The MCP server never
 *    decides who may see or touch which app: `request_access` asks the app,
 *    and the app asks a person.
 *
 *    - `POST {api}/api/desktop/access`              {@link DesktopAccessRequest} → 200 / 201 / 202 {@link DesktopAccessState}
 *    - `GET  {api}/api/desktop/access/{requestId}?waitMs=<n>` → 200 {@link DesktopAccessState}
 *
 *    The GET may hold the request up to `waitMs` while the state is `pending`
 *    (long poll), and answers `pending` when the time is up; the server asks
 *    again. `Authorization: Bearer <token>` only when the server was given a
 *    token. Never `Origin`. A refusal is a 4xx / 5xx with
 *    {@link DesktopRefusal} (the same shape as the peers server's).
 *
 * 2. **The helper protocol**: JSON lines over the native helper's Unix socket
 *    (desktop-helper/Sources/SynapseDesktopHelper/Handler.swift has the table).
 */

export const DESKTOP_ACCESS_PATH = "/api/desktop/access";

/** One app the agent asked for, as the helper resolved it. `bundleId` is null when no installed app matched. */
export interface DesktopAppRequest {
  /** What the agent wrote (a name like `TextEdit` or a bundle id). */
  readonly query: string;
  readonly bundleId: string | null;
  readonly name: string | null;
  /** Screenshot-only whatever is granted (browsers): the approval UI may say so. */
  readonly readOnly: boolean;
}

export interface DesktopAccessRequest {
  /** Who is asking: the id the server was started with (`--desk-id`). */
  readonly deskId: string;
  readonly apps: readonly DesktopAppRequest[];
  /** The agent's reason, shown to the person who approves. */
  readonly reason: string;
}

export type DesktopAccessStatus = "pending" | "granted" | "denied" | "expired";

export interface DesktopAccessState {
  readonly requestId: string;
  readonly status: DesktopAccessStatus;
  /** `granted`: the bundle ids granted (a subset of those asked; anything else is dropped). */
  readonly apps?: readonly string[];
  /** `granted`: bundle ids granted for screenshots only (on top of the browsers, which are always). */
  readonly readOnly?: readonly string[];
  /** `granted`: when the grant ends, ISO 8601. Required: a grant without an end is refused. */
  readonly expiresAt?: string;
  /** For the model: the person's note on a denial, etc. */
  readonly message?: string;
}

/** A refusal from the app: 4xx / 5xx with this body. */
export interface DesktopRefusal {
  readonly error: string;
  readonly reason: string;
  readonly detail?: string;
  readonly [extra: string]: unknown;
}

/**
 * Codes the MCP server itself makes, besides passing the app's and the
 * helper's through.
 */
export type DesktopLocalReason =
  /** The app could not be reached, or answered in another shape, or not in time. */
  | "server-unreachable"
  /** The helper is not running and could not be started. */
  | "helper-unavailable"
  /** No grant yet: call request_access. */
  | "no-access"
  /** The grant's expiresAt has passed. */
  | "expired"
  /** The user pressed Esc / Stop. */
  | "aborted"
  /** The app is screenshot-only (a browser, or marked readOnly). */
  | "read-only"
  /** The app was not granted. */
  | "not-allowed"
  /** A name that matches no installed app. */
  | "unknown-app"
  /** Click coordinates before any screenshot, or outside it. */
  | "no-screenshot"
  | "bad-request";

// ---------------------------------------------------------------------------
// The helper protocol (Unix socket, JSON lines)

/** `{id, op, ...params}` → `{id, ok: true, result}` | `{id, ok: false, reason, error, ...}`. */
export type HelperResponse<T> = { ok: true; result: T } | ({ ok: false } & DesktopRefusal);

/** An unsolicited line from the helper. */
export interface HelperEvent {
  readonly event: "aborted" | (string & {});
  readonly session?: string;
  /** `esc` / `menu`. */
  readonly by?: string;
}

export interface HelperStatus {
  readonly version: string;
  readonly pid: number;
  readonly socket: string;
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly escWatcher: boolean;
  readonly session: { id: string; apps: string[]; inputApps: string[]; expiresAt: number | null } | null;
}

export interface HelperResolvedApp {
  readonly query: string;
  readonly bundleId: string | null;
  readonly name: string | null;
  readonly path: string | null;
}

/** A screenshot and where it lies on the screen, in global points. */
export interface HelperScreenshot {
  readonly data: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly pointWidth: number;
  readonly pointHeight: number;
  readonly backingScale: number;
  /** The bundle ids whose windows were captured (granted and running). */
  readonly apps: readonly string[];
}

/** The default socket, under the user's Application Support. */
export const DEFAULT_HELPER_SOCKET_SUFFIX = "Library/Application Support/synapse-desktop/helper.sock";
export const HELPER_BUNDLE_ID = "com.mizunowanko.synapse-desktop-helper";
