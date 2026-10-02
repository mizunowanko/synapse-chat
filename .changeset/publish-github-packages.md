---
"@mizunowanko/synapse-chat-core": minor
"@mizunowanko/synapse-chat-react": minor
"@mizunowanko/synapse-chat-server": minor
"@mizunowanko/synapse-chat-mcp": minor
---

First release, published to GitHub Packages (#68)

The packages are published as `@mizunowanko/synapse-chat-{core,react,server,mcp}`
because GitHub Packages requires the npm scope to match the repository owner.
Import paths do not change: consumers install them under the old names through an
npm alias, e.g. `"@synapse-chat/core": "npm:@mizunowanko/synapse-chat-core@0.1.0"`.
All four packages share one version.
