---
'playwriter': patch
---

`POST /recorder/start` now creates a session when none exists, instead of
failing with:

```
No sessions. Run 'playwriter session new' first.
```

The extension toolbar **Record Skill** button sends no `sessionId`, so it
only worked when a CLI or MCP session happened to be running. It now
behaves like `playwriter recorder start`: reuse the only session, or create
a default one bound to the connected extension.

Resolution order for a request without `sessionId`:

```
explicit sessionId          ►  use it
free extension session      ►  use it
no free extension session   ►  create one from the connected extension
```

If no extension is connected, the error is now
`Extension is not connected. Enable Playwriter on a tab first.`
