---
'playwriter': patch
---

When 10 skill recordings are already active, a new `recorder start` stops the **oldest** recording and starts the new one. The start no longer fails with 429.

The 10-recording cap still bounds CPU and disk. The user never has to stop a recording by hand to start another.
