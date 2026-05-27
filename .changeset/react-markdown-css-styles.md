---
"@synapse-chat/react": minor
---

Add default Markdown CSS styles via `@synapse-chat/react/styles` subpath export.

Consumers can opt in by importing:

```typescript
import "@synapse-chat/react/styles";
```

The stylesheet styles `.synapse-chat-markdown` elements (tables, code blocks, blockquotes, lists, headings) and exposes CSS custom properties for theming:

- `--synapse-chat-border` (default: `#e2e8f0`)
- `--synapse-chat-code-bg` (default: `#f8fafc`)
- `--synapse-chat-muted` (default: `#64748b`)
