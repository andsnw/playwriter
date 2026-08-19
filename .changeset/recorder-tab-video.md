---
'playwriter': minor
---

Action recording now saves a jpeg for each visual change via CDP screencast.
No extension icon click is required. Frames go in
`~/.playwriter/recordings/<id>/frames/<ms>.jpg`. Events carry the same
`ms` field. User clicks flash a pink ripple in the frames.

```bash
ls ~/.playwriter/recordings/14/frames/
```
