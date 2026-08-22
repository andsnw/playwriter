# Recording is active — how to turn it into a skill

The user is performing a workflow in their browser. Clicks, fills, keypresses,
navigations, and mutating xhr/fetch are written to a JSON event file. CDP
screencast writes a jpeg into a frames folder whenever the page changes. User
clicks flash a short ripple in those frames. Recording auto-stops after 20 minutes.

The end goal: a **skill** (`SKILL.md` plus an importable utils script) that
replays the flow with **playwriter** commands. Never drive the browser with raw
Playwright or `npx playwright`.

## First: read how Playwriter works

Do this once per session, **before** any playwriter command. Read the full output.
Never pipe through `head`, `tail`, `sed`, or any truncation:

```bash
playwriter skill
```

Or fetch https://playwriter.dev/SKILL.md (same content). Always use the **playwriter**
CLI after that (`playwriter -s <id> -e '...'`). Context variables (`page`, `context`,
`snapshot`, …) only exist inside that sandbox.

## While the user records

Stay with the user. You may run playwriter commands on this session if they ask
(snapshot, inspect, click something). If they did not ask, ask first. Do not drive
the workflow yourself.

Tell the user: take your time, pauses and mistakes are fine. Dead ends can be
filtered out later.

When the user says stop/done:

```bash
playwriter recorder stop
```

If that errors because more than one recording is active, the message lists
each recording id with its current or last page URL. Pick the one that matches
this workflow (or ask the user), then `playwriter recorder stop <id>`.

## Inspect the events

`recorder events` prints one JSON object per line (jq-friendly). `t` is seconds
since start. Every event has a sequential `id` and `ms` (milliseconds since start).
The default output is a **thin timeline**: heavy payloads (network bodies) are
replaced by sizes. Pass event ids to get full details. Defaults to the latest
recording; pass `-r <recordingId>` for an older one.

```bash
# thin timeline
playwriter recorder events | jq -r '[.id, .t, .type, (.code // .url // .signal // .message // .kind // empty)] | @tsv'

# full details of specific events
playwriter recorder events 4 7 12

# recorded actions only
playwriter recorder events | jq -r 'select(.type == "action") | .code'

# mutating xhr/fetch (POST/PUT/PATCH/DELETE). Thin view shows sizes.
playwriter recorder events | jq -r 'select(.type == "network") | [.id, .method, .status, .url, .responseBodySize] | @tsv'
playwriter recorder events 14 15

# downloads, uploads, console errors, page errors
playwriter recorder events | jq 'select(.type == "download" or .type == "console" or .type == "page-error" or (.type == "action" and .action == "setInputFiles"))'
```

Event types: `recording-started`, `action` (`.code` is locator code such as
`await page.getByRole('button', { name: 'Submit' }).click()`), `signal`,
`navigation`, `page-opened`, `page-closed`, `network` (mutating xhr/fetch with
truncated `responseBody`), `download`, `console`, `page-error`,
`recording-stopped` (includes `framesDir` and `frameCount`).

Action events also carry structured fields copied from Playwright: `text` (fill),
`key` (press), `options` (select), `files` (setInputFiles), `button` and
`modifiers` (click/press). Prefer those over parsing `.code`.

Drop select-all / modifier keypresses that happen just before a fill. They are
noise. The fill already has the final text.

Role names in generated locators may be prefixes of the live accessible name.
They still match. Verify against a live snapshot before trusting them.

## Frames

`framesDir` on the start/stop events is a folder of jpegs
(`~/.playwriter/recordings/<id>/frames`). Chrome only writes a frame when the
page changes. Files are named `<ms>.jpg` where `ms` is milliseconds since start.
Every event has the same `ms` field.

To see the screen at an event, **read the jpeg whose filename is closest to that
event's `ms`**. A pink ripple marks the click. Do not write awk/ls pipelines;
open the image file directly.

## Prototype against the live page

Do not trust recorded locators blindly. Use the same playwriter session:

```bash
playwriter -s <session> -e 'console.log(await snapshot({ page }))'
playwriter -s <session> -e 'await page.getByRole("button", { name: "Submit" }).click()'
```

Loop: snapshot → run one recorded action → snapshot again. Drop actions the user
flagged as mistakes.

## Write the skill

Guess sensible defaults from the events (name, location, use case, parameters)
and **write the skill**. Then tell the user what you assumed. Demo values the
user typed should almost always be parameters, not hardcoded strings.

Use the [Agent Skills](https://agentskills.io) default locations, not a
client-specific folder such as `~/.config/opencode/skills/`:

- personal (all projects): `~/.agents/skills/<name>/`
- project-local: `.agents/skills/<name>/` in the current repo

Write **`SKILL.md`** and a **`utils.js`** (or `utils.ts`) in that directory.

`SKILL.md` frontmatter has `name` and `description` (when to load the skill).
The body explains the flow as **markdown instructions with example playwriter
commands** built from the recorded events:

````markdown
---
name: submit-to-directory
description: >
  Submit a product to the directory. Use when the user wants to add or update
  a listing on directory.example.com.
---

# Submit to directory

Preconditions: the user is already signed in. Playwriter drives their browser.

1. Open the submit page

```bash
playwriter -s 1 -e 'await page.goto("https://directory.example.com/submit")'
```

2. Fill the product name (parameter), then the website URL

```bash
playwriter -s 1 -e 'const name = "Acme"; await page.getByRole("textbox", { name: "Product name" }).fill(name)'
playwriter -s 1 -e 'const url = "https://acme.com"; await page.getByRole("textbox", { name: "Website URL" }).fill(url)'
```

3. Click Submit. Expect POST `/api/products` and confirmation text.

```bash
playwriter -s 1 -e 'await page.getByRole("button", { name: "Submit" }).click()'
playwriter -s 1 -e 'await page.getByText("Thanks! Your product is under review.").waitFor()'
```

Or import the utils script (preferred for replay; fewer tokens):

```bash
playwriter -s 1 -e 'const { submitProduct } = await import("/abs/path/.agents/skills/submit-to-directory/utils.js"); await submitProduct({ page, name, url })'
```
````

`utils.js` is an importable ESM script. Export functions that accept `{ page }`
plus parameters. Keep them small (one per phase, plus one top-level that runs
the whole flow). The playwriter sandbox can import local files.

Rules:

- Always `playwriter -s <id> -e '...'`. Never raw Playwright.
- Use locators verified against the live page. Recorded `.code` is the starting point.
- After each action, wait for the outcome seen in the events (`waitForURL`,
  `locator.waitFor`, or the mutating network request). No blind sleeps.
- Parameterize demo-typed values. Keep everything else literal.
- If the flow needs auth, check a signed-in indicator first and tell the user
  to log in if it is missing.
- Never hardcode secrets, cookies, or tokens.
- If a cookie banner / modal sometimes appears, detect it, dismiss it, retry
  once. Do not add generic retry loops.
- Throw or print a clear error when an expected outcome does not appear.

If recorded `network` events show a clean fetch/XHR JSON API, calling that API
(in-page `fetch`, same cookies) is faster than driving the UI. Prefer UI
automation when unsure, and mention the API alternative in the skill.

## Validate

The skill is not done until replay succeeds end-to-end with test parameters.
Prefer replaying the utils script. If that fails, snapshot the live page, fix
the locator or wait, and run again.

## Updating an existing skill

If a similar skill already exists (check the location first), update it instead
of creating a new one: read the current SKILL.md and utils file, re-record or
compare locators, fix the root cause, keep working parts, re-validate.

## Checklist

- Locators come from recorded events and were verified live
- Every step has a verifiable outcome
- Demo-typed values are parameters
- Waits reflect real timing (user remarks + event gaps)
- Secrets are never hardcoded
- Replay uses playwriter commands (inline `-e` or an imported utils script)
- The flow was validated end-to-end at least once
