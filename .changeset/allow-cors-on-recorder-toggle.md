---
'playwriter': patch
---

Allow cross-origin `POST /recorder/start` and `POST /recorder/stop` on the
relay so the extension toolbar **Record Skill** button works on every site.

Before, the toolbar fetched the relay from the page origin and the browser
rejected the preflight:

```
Access to fetch at 'http://127.0.0.1:19988/recorder/start' from origin
'https://example.com' has been blocked by CORS policy
```

Only these two toggle routes are opened up. They return
`{ recordingId, sessionId }` and nothing else; recorded event data stays
behind `/recorder/events/:id`, which remains extension-only. Code
execution and CDP forwarding routes are unchanged.

The remaining defenses still apply to the toggle routes:

| defense                       | applies to `/recorder/start` |
| ----------------------------- | ---------------------------- |
| `Content-Type: application/json` required | yes              |
| token auth in remote mode     | yes                          |
| Host header / DNS rebinding check | yes                      |
| `Sec-Fetch-Site` cross-origin block | no (intentional)       |

The worst a malicious page can do is start or stop a recording, which the
toolbar shows as `Recording skill…`.
