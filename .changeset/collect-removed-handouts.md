---
"@synapse-chat/core": minor
---

fix(core/briefing): `collect()` takes out skills and subagents whose handout was deleted

A skill deleted from `.claude/skills/` used to stay in the Briefing forever:
a missing handout read the same as an unedited one. `collect()` now takes the
entry out — but **only with proof on disk that it was handed out**: some
handout in the same directory still carries a fingerprint, and another layout
still has the entry's handout. A provider that was never handed out to, a
hand-written directory mid-migration, an absent directory, or an entry no
layout has a handout for keeps every entry, as before.

What was taken out is reported in the new `CollectResult.removed`
(`{ kind, name, path }[]`), so the caller can detect a deletion that conflicts
with a write-in elsewhere and tidy up the other layouts' handouts — `handOut()`
still cannot express a deletion.
