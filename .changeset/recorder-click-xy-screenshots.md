---
'playwriter': minor
---

Speed up action recording and add click coordinates plus highlighted screenshots.

Typing no longer rebuilds a Playwright locator on every key. Clicks wait 200ms so a double click is one action. Each click stores page `x`/`y` and a PNG with a rectangle on the target.

Network events are now **POST / PUT / PATCH / DELETE** xhr and fetch only. GET document traffic is dropped.

```bash
playwriter recorder events | jq -r 'select(.type == "action" and .action == "click") | [.id, .x, .y, .code] | @tsv'
playwriter recorder events | jq -r 'select(.type == "screenshot") | [.afterActionId, .path] | @tsv'
```
