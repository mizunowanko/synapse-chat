export {
  ChatMessage,
  type ChatMessageContext,
  type ChatMessageProps,
} from "./components/ChatMessage.js";
export {
  ToolUseGroup,
  type ToolUseGroupProps,
} from "./components/ToolUseGroup.js";
export { SessionInput, type SessionInputProps } from "./components/SessionInput.js";

export {
  useChat,
  type UseChatOptions,
  type UseChatResult,
  type OptimisticMessageStatus,
} from "./hooks/useChat.js";
export {
  useWebSocket,
  type UseWebSocketResult,
} from "./hooks/useWebSocket.js";
export { useConnectionStatus } from "./hooks/useConnectionStatus.js";
export {
  useTokenUsage,
  type CumulativeTokenUsage,
} from "./hooks/useTokenUsage.js";

export {
  WSClient,
  defaultWsUrl,
  type WSClientOptions,
  type WSClientLogger,
  type ConnectionStatus,
} from "./lib/ws-client.js";
export {
  groupToolMessages,
  isToolGroup,
  type DisplayItem,
  type ToolUseGroupItem,
} from "./lib/group-tool-messages.js";
export {
  createMessageFilter,
  type CreateMessageFilterOptions,
  type MessageFilterRule,
} from "./lib/message-filters.js";
export { remarkIssueLink } from "./lib/remark-issue-link.js";
export { formatTime } from "./lib/format-time.js";
export { cn, isSafeUrl } from "./lib/utils.js";

// Re-export core types that chat consumers will inevitably need.
export type {
  StreamMessage,
  StreamMessageType,
  ImageAttachment,
  TokenUsage,
} from "@synapse-chat/core";
