---
'playwriter': patch
---

Fix `snapshot()` returning the previous accessibility tree immediately after full-page or client-side navigation. Snapshots now wait for the browser render lifecycle to update its accessibility cache before reading it.
