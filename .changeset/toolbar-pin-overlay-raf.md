---
'playwriter': patch
---

Pin-mode hover overlay now updates at most once per frame and hides with `visibility` instead of `display`, so moving the cursor over a heavy page does not force a layout on every mouse event.
