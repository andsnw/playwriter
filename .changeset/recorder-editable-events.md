---
'playwriter': patch
---

Store `playwriter recorder` events as an editable JSON array instead of append-only jsonl.

Fill keystrokes from Playwright (`actionUpdated`) now update the last action in place. The 800ms coalesce timer is gone. Files live at `~/.playwriter/recordings/<id>.json`. `playwriter recorder events` still prints one JSON object per line for jq.
