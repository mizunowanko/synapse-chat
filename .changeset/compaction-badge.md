---
"@synapse-chat/react": minor
---

feat(react): add CompactionBadge component and auto-render on compaction system messages

- New `CompactionBadge` component exported from `@synapse-chat/react` with animate-pulse violet styling
- `ChatMessage` now auto-renders `CompactionBadge` when `message.subtype` is `"compact-status"` or `"compacting"`
- Existing `renderSystem` prop continues to override the default behavior
