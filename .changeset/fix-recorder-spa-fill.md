---
'playwriter': patch
---

Fix skill-recorder fills and cookie diffs after the editable-array change.

- A `history.pushState` mid-fill no longer splits one field into two actions. `actionUpdated` now edits the last action, not the last action on the same URL.
- Snapshot/storage capture for fills waits until typing pauses. The action JSON still updates on every keystroke.
- Cookie diffs are scoped by origin, so navigating away no longer looks like logout.
- Recording files are replaced atomically (temp file + rename).
