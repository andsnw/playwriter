---
'playwriter': patch
---

Allow the agent to run playwriter commands while a recording is active, if the user asks.

`recorder start` used to tell the agent to wait and never touch the session. The printed prompt and skill now say: stay with the user, ask before you exec, and only drive the page when they ask.
