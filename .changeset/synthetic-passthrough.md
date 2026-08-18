---
"@synapse-chat/server": patch
---

fix(claude): keep replies that arrive without deltas

Partial mode dropped every finished `text` / `thinking` block on the assumption
that deltas always came first. Locally synthesised replies — `/clear` and
friends, answered by the CLI itself with `model: "<synthetic>"` — emit no
`stream_event` at all, so dropping their finished message deleted the only copy
and left consumers waiting for a reply that never came.

`createStreamMessageParser()` conditions the suppression on an observed fact
instead: was a delta actually seen for the message now finishing. The flag
resets at `message_start` and `result`, never on a finished message — one
`message_start` yields several finished `assistant` lines and resetting on the
first would double the body.
