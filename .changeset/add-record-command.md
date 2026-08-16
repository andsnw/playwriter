---
'playwriter': minor
---

Add `playwriter record` commands to record user browser workflows as jsonl events for skill generation.

```bash
playwriter recorder start        # starts recording user actions (runs in the relay daemon)
# ... user performs the workflow manually in the browser ...
playwriter recorder stop         # stops and prints event count + jsonl file path
playwriter recorder events <id>  # thin timeline view (heavy payloads shown as sizes)
playwriter recorder events <id> 4 7  # full details of events 4 and 7 (bodies, full diffs)
playwriter recorder status       # lists active recordings
```

Recorded events include:

- `action` events with generated Playwright locator code (e.g. `await page.getByRole('button', { name: 'Submit' }).click()`), produced by the playwright fork's headless recorder (`recorderMode: 'api'`)
- `snapshot-diff` events showing how the aria snapshot changed after each action
- `network` events (document/xhr/fetch requests with method, status, post data, and response bodies for JSON/text responses — enough to reverse-engineer a site's internal API into a typed client)

Every event has a sequential `id`. The default `recorder events` output is a thin timeline where heavy payloads (response bodies, snapshot diffs, storage values) are replaced by sizes or key lists; pass event ids to read the full details, or `--full` for the raw stream.
- `download` events (source url + suggested filename) and `file-upload` events (file names chosen in `input[type=file]`)
- `cookies` and `storage` events (localStorage/sessionStorage diffs after each action)
- `console` errors/warnings and `page-error` events, making recordings usable as bug reproduction reports
- `navigation`, `url-changed` (SPA pushState), `page-opened`, `focus` and `scroll` events

Fixes #114

`recorder start` prints detailed agent instructions for turning the recording into a reusable skill: a SKILL.md describing the flow (locators, expected UI/url changes, network requests) plus an importable utils script that automates the same flow with few tokens. Events persist in `~/.playwriter/recordings/<id>.jsonl` and survive relay restarts.
