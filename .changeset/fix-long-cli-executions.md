---
'playwriter': patch
---

Fix CLI executions that run for more than five minutes. The execute request now follows the configured `--timeout` instead of failing at Node's fixed 300-second response-header timeout.

Fixes #74
