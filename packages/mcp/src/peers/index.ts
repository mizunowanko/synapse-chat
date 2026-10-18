/**
 * `@synapse-chat/mcp/peers` — a stdio MCP server that lets a CLI session
 * message the app's other sessions, through two HTTP endpoints the app
 * implements (docs/design/peers-mcp.md).
 *
 * No `node:sqlite`: works on Node 20.
 */
export {
  PEERS_LIST_PATH,
  PEERS_MESSAGES_PATH,
  PEER_REFUSAL_REASONS,
  SERVER_UNREACHABLE,
  type PeerState,
  type PeerProvider,
  type PeerEntry,
  type PeersListResponse,
  type SendPeerMessageRequest,
  type SendPeerMessageResponse,
  type PeerDeliveryStatus,
  type PeerRefusalReason,
  type PeerErrorReason,
  type PeerRefusal,
} from "./contract.js";
export {
  createPeersClient,
  assertPeersApiUrl,
  assertPeersToken,
  DEFAULT_PEERS_TIMEOUT_MS,
  type PeersClient,
  type PeersClientOptions,
  type PeersResult,
} from "./client.js";
export {
  createPeersMcpServer,
  createPeersToolHandler,
  refusalResult,
  PEERS_SERVER_NAME,
  PEERS_SERVER_VERSION,
  PEERS_INSTRUCTIONS,
  PEERS_TOOLS,
  type PeersServerOptions,
  type PeersServerHandle,
} from "./server.js";
export {
  peersServerEntry,
  claudePeersMcpServers,
  claudePeersMcpConfig,
  codexPeersConfigArgs,
  agyPeersPluginFiles,
  withdrawPeersFiles,
  AGY_PEERS_PLUGIN,
  type PeersLaunchOptions,
} from "./registration.js";
