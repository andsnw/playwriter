---
'playwriter': patch
---

Name screencast frames `<ms>.jpg` and add `ms` (milliseconds since
recording start) to every recorded event so an agent can pick the
frame just before a click:

```bash
ls "$FRAMES" | awk -F'[.-]' '$1+0 <= 8200 { print }' | tail -1
```
