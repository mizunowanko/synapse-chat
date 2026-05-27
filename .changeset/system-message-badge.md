---
"@synapse-chat/react": minor
---

Add `SystemMessageBadge` component for rendering system message subtypes as styled badges.

Consumers pass a `variants` map of `subtype → { label, icon?, colorClass? }` and the component renders the matching badge, or a `fallback` node when the subtype is not found. An optional `message` prop provides access to the full `StreamMessage` for metadata.

```tsx
<SystemMessageBadge
  subtype={message.subtype ?? ""}
  variants={{
    "gate-check-request": { label: "Gate Check", icon: "🔍", colorClass: "bg-indigo-100 text-indigo-800" },
    "lookout-alert":      { label: "Alert",      icon: "🚨", colorClass: "bg-red-100 text-red-800" },
  }}
  message={message}
/>
```
