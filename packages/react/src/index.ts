export {
  ChatMessage,
  type ChatMessageContext,
  type ChatMessageProps,
} from "./components/ChatMessage.js";
export {
  CollapsibleOutput,
  type CollapsibleOutputProps,
} from "./components/CollapsibleOutput.js";
export {
  CollapsibleThinking,
  type CollapsibleThinkingProps,
} from "./components/CollapsibleThinking.js";
export {
  ThinkingMessage,
  type ThinkingMessageProps,
} from "./components/ThinkingMessage.js";
export {
  CompactionBadge,
  type CompactionBadgeProps,
} from "./components/CompactionBadge.js";
export {
  ConnectionStatusBadge,
  type ConnectionStatusBadgeProps,
  type ConnectionStatusBadgeVariant,
} from "./components/ConnectionStatusBadge.js";
export {
  SystemMessageBadge,
  type SystemMessageBadgeProps,
  type SystemMessageVariantConfig,
} from "./components/SystemMessageBadge.js";
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
  isThinkingGroup,
  type DisplayItem,
  type ToolUseGroupItem,
  type ThinkingGroupItem,
} from "./lib/group-tool-messages.js";
export { groupThinkingMessages } from "./lib/group-thinking-messages.js";
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
  Attachment,
  AttachmentImageMediaType,
  StreamMessage,
  StreamMessageType,
  ImageAttachment,
  TokenUsage,
} from "@synapse-chat/core";
