---
"@synapse-chat/server": patch
---

Drop `system:thinking_tokens` progress events in the stream parser. Claude CLI emits these extended-thinking progress notifications roughly every second, and they were previously passing the `system` message filter — flooding chat logs, DB storage, and frontend broadcasts. The token total remains available in the `result` message's `usage` block, so cost accounting is unaffected.
