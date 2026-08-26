---
"@synapse-chat/server": minor
---

feat(claude): surface `conversation_reset` as a `system` message

`/clear` emits a `conversation_reset` line carrying only ids and a timestamp.
It used to be dropped, which was harmless while the CLI still followed it with a
synthetic `"(no content)"` assistant message — the trace consumers actually
rendered. The CLI stopped emitting that, leaving `/clear` silent.

It now parses to `{ type: "system", subtype: "conversation-reset" }`. Whether
that draws anything is the app's call: consumers whitelist the `system` subtypes
they can render, so nothing changes for one that does not list it.
