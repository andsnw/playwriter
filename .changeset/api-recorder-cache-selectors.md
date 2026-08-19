---
'@xmorse/playwright-core': patch
---

API-mode recorder now caches the locator for the focused element and stalls clicks 200ms so a double click is one action with `clickCount: 2`.
