---
'playwriter': patch
---

Stop allowing any website origin on `POST /recorder/start` and `/recorder/stop`.

The toolbar Record button already starts recording from the extension service worker, which uses the `chrome-extension://` origin. Wildcard CORS was leftover from when the page fetched the relay directly.

A page can no longer pass the CORS preflight, so it cannot start or stop a recording. The CLI and the extension worker are unchanged.
