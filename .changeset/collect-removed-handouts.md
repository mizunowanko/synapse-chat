---
"@synapse-chat/core": minor
---

fix(core/briefing): `collect()` takes out skills and subagents whose handout was deleted

A skill deleted from `.claude/skills/` used to stay in the Briefing forever:
a missing handout read the same as an unedited one. `collect()` now takes the
entry out — but **only where the layout provably handed out to that directory**
(some handout there still carries a fingerprint). A provider that was never
handed out to, a hand-written directory mid-migration, or an absent directory
keeps every entry, as before.

What was taken out is reported in the new `CollectResult.removed`
(`{ kind, name, path }[]`), so the caller can detect a deletion that conflicts
with a write-in elsewhere and tidy up the other layouts' handouts — `handOut()`
still cannot express a deletion.
