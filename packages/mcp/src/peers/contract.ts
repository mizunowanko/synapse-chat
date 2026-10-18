/**
 * The HTTP contract between the peers MCP server and the app that delivers
 * the messages (docs/design/peers-mcp.md「HTTP の取り決め」).
 *
 * synapse-chat owns these types; the app implements the two endpoints. The
 * MCP server is a thin relay: it never interprets an address, a state or a
 * refusal beyond copying it to the model.
 *
 * - `GET  {api}/api/peers`           → 200 {@link PeersListResponse}
 * - `POST {api}/api/peers/messages`  {@link SendPeerMessageRequest} → 200 {@link SendPeerMessageResponse}
 *
 * Both take `Authorization: Bearer <token>` (the token names the sender; the
 * body never does). A POST is `Content-Type: application/json`. Neither
 * carries `Origin` (the app refuses any request that does). A refusal is a
 * 4xx / 5xx with {@link PeerRefusal}.
 */

export const PEERS_LIST_PATH = "/api/peers";
export const PEERS_MESSAGES_PATH = "/api/peers/messages";

/** What a peer is doing now. `stopped`: no process; a message is still delivered (the app starts it). */
export type PeerState = "idle" | "working" | "stopped";

/** The CLI behind a peer's current session. Open-ended: an app may add one. */
export type PeerProvider = "claude" | "codex" | "gemini" | (string & {});

export interface PeerEntry {
  /** What `send_message` takes as `to`. */
  readonly address: string;
  readonly agent: string;
  readonly displayName: string;
  readonly desk: string;
  readonly provider: PeerProvider;
  readonly state: PeerState;
  /** The caller's own entry. */
  readonly self: boolean;
}

export interface PeersListResponse {
  /** The caller's own address (what a reply goes to). */
  readonly self: string;
  readonly peers: readonly PeerEntry[];
}

export interface SendPeerMessageRequest {
  readonly to: string;
  readonly message: string;
}

/** `delivered`: written into the peer's session. `queued`: the peer is mid-turn; the app writes it when the turn ends. */
export type PeerDeliveryStatus = "delivered" | "queued";

export interface SendPeerMessageResponse {
  readonly id: string;
  /** The address after the app resolved it. */
  readonly to: string;
  readonly status: PeerDeliveryStatus;
  /** The peer was stopped and the app started it first. */
  readonly woke: boolean;
}

/** The codes the app puts in a refusal's `reason`. */
export type PeerRefusalReason =
  | "unauthorized"
  | "origin-refused"
  | "bad-request"
  | "too-long"
  | "unknown-address"
  | "self"
  | "not-reachable"
  | "chain-limit"
  | "rate-limited"
  | "wake-failed";

export const PEER_REFUSAL_REASONS: readonly PeerRefusalReason[] = [
  "unauthorized",
  "origin-refused",
  "bad-request",
  "too-long",
  "unknown-address",
  "self",
  "not-reachable",
  "chain-limit",
  "rate-limited",
  "wake-failed",
];

/**
 * The one code the MCP server makes itself: the app could not be reached, or
 * did not answer in the contract's shape (no `reason`), or did not answer in
 * time. `detail` says which.
 */
export const SERVER_UNREACHABLE = "server-unreachable";

/** Every `reason` the model can see. Open-ended: an app's newer code is passed through as is. */
export type PeerErrorReason = PeerRefusalReason | typeof SERVER_UNREACHABLE | (string & {});

/** A refusal's body. Fields beyond `error` / `reason` depend on the reason. */
export interface PeerRefusal {
  /** For people (and the model). */
  readonly error: string;
  readonly reason: PeerErrorReason;
  /** `too-long`: the longest message accepted. */
  readonly limit?: number;
  /** `unknown-address`: up to 3 addresses close to `to`. */
  readonly candidates?: readonly string[];
  /** `not-reachable` / `wake-failed` / `server-unreachable`: why. */
  readonly detail?: string;
  /** `chain-limit`: the depth this message would have had, and the limit. */
  readonly depth?: number;
  /** `rate-limited`: when to try again (also `Retry-After`). */
  readonly retryAfterSeconds?: number;
  /** `rate-limited`: `pair` (this sender to this peer) or `sender` (this sender to anyone). */
  readonly scope?: "pair" | "sender" | (string & {});
  readonly [extra: string]: unknown;
}
