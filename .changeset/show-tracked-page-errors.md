---
'playwriter': patch
---

Show uncaught browser exceptions automatically in CLI and MCP execution output.

Only pages assigned directly to the current session's `state` keys report these errors. Agents using separate sessions and tabs no longer receive exceptions from each other's pages.

```text
[PAGE ERROR] Uncaught TypeError: Cannot read properties of undefined
```
