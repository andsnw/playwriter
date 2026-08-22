---
'playwriter': patch
---

Tell the recorder prompt that WebSockets are not captured. If the user submitted a job and the events have no matching POST, grep the live page for `wss://` / `new WebSocket` and call the socket from `page.evaluate`. A quota or analytics POST is not the generate call.
