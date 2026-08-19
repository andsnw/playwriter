---
'playwriter': patch
'@xmorse/playwright-core': patch
---

Simplify action recording. Drop late click screenshots, custom x/y, the 200ms
click stall, and scroll polling. File picks are now `setInputFiles` actions.
Network stays POST/PUT/PATCH/DELETE xhr and fetch only.

Typing still reuses the focused-element locator so large pages stay fast.
