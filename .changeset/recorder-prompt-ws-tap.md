---
'playwriter': patch
---

Show how to reverse-engineer WebSockets that the recorder missed: install a typed `WebSocket` tap with `page.addInitScript`, reload, replay the user action, then dump construct/send/message events.
