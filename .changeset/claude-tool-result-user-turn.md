---
"@synapse-chat/server": patch
---

fix(server): parse Claude's `tool_result` out of the wrapping `user` turn

Claude delivers every tool result as a `user` turn — the API's own convention,
since results are fed back as user-role content:

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"tool_result","tool_use_id":"toolu_…","content":"1\thello"}]}}
```

`parseStreamMessage` had no `case "user"`, so the whole turn was dropped and
Claude sessions rendered tool calls that never visibly completed. agy / Codex
were unaffected: their adapters build `StreamMessage` directly and never reach
this parser.

Only `tool_result` blocks are lifted out. A `user` turn also carries the
operator's own prompt, which the client already appended when it sent it, so
passing that through would draw every question twice.

`is_error: true` rides along as `meta.isError`, mirroring how the Codex adapter
carries `exitCode`. Non-text result blocks (an image `Read`) yield a
`tool_result` with no `content` rather than a base64 dump.
