/**
 * `@synapse-chat/mcp/desktop` — a stdio MCP server that lets a CLI session
 * see and operate macOS apps, with tools close to Anthropic's computer-use
 * set (docs/design/desktop-mcp.md). Access is granted by a person through an
 * approval API the app implements; the screen and the input belong to a
 * native helper (`desktop-helper/`, built separately) that owns the macOS
 * permissions.
 *
 * No `node:sqlite`: works on Node 20.
 */
export {
  DESKTOP_ACCESS_PATH,
  DEFAULT_HELPER_SOCKET_SUFFIX,
  HELPER_BUNDLE_ID,
  type DesktopAppRequest,
  type DesktopAccessRequest,
  type DesktopAccessStatus,
  type DesktopAccessState,
  type DesktopRefusal,
  type DesktopLocalReason,
  type HelperResponse,
  type HelperEvent,
  type HelperStatus,
  type HelperResolvedApp,
  type HelperScreenshot,
} from "./contract.js";
export {
  createApprovalClient,
  assertDesktopApiUrl,
  assertDesktopToken,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalClient,
  type ApprovalClientOptions,
  type ApprovalResult,
} from "./approval.js";
export {
  createHelperClient,
  defaultHelperSocket,
  defaultHelperApp,
  type HelperClient,
  type HelperClientOptions,
} from "./helper-client.js";
export { BROWSER_BUNDLE_IDS, isBrowser, toPoint, toPixel, toPointRect, type ScreenGeometry } from "./policy.js";
export {
  createDesktopMcpServer,
  createDesktopToolHandler,
  desktopRefusalResult,
  DESKTOP_SERVER_NAME,
  DESKTOP_SERVER_VERSION,
  DESKTOP_INSTRUCTIONS,
  DESKTOP_TOOLS,
  DEFAULT_SCREENSHOT_MAX,
  type DesktopServerOptions,
  type DesktopServerHandle,
} from "./server.js";
export {
  desktopServerEntry,
  claudeDesktopMcpServers,
  codexDesktopConfigArgs,
  agyDesktopPluginFiles,
  withdrawDesktopFiles,
  AGY_DESKTOP_PLUGIN,
  type DesktopLaunchOptions,
} from "./registration.js";
