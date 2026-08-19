---
'playwriter': patch
'@xmorse/playwright-core': patch
---

Fix `playwriter recorder start` hanging on tabs with frames that never get a document (empty targets, some iframes). Start now fails in 15s instead of leaving a zombie recording, and every recording auto-stops after 20 minutes.

```bash
playwriter recorder start -s 1
# records the current Playwriter tabs; no new tab is opened
# auto-stops after 20 minutes
```
