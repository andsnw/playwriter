# Recording is active — how to turn it into a skill

The user is now performing a workflow manually in their browser. Every click, fill,
keypress, navigation, and mutating xhr/fetch is being written to a JSON event file.
CDP screencast writes a jpeg into a frames folder whenever the page changes.
User clicks flash a short ripple in those frames. Recording auto-stops after 20 minutes.

The end goal: a **skill** (SKILL.md + importable utils script) that automates the
same flow with playwriter. Follow the phases below in order.

## Phase 1: while the user records

Stay with the user. Ask (if not already known):

- What is the goal of this workflow, in one sentence?
- What inputs vary between runs (e.g. product name, patient DOB, search query)?
- What is the expected output or end state (data extracted, form submitted, email sent)?

You may run playwriter commands on this session if the user asks (snapshot, inspect,
click something). If they did not ask, ask first. Do not drive the workflow yourself.

Tell the user: take your time, pauses and mistakes are fine. Dead ends can be
filtered out later, so they should just use the app normally.

When the user says stop/done:

```bash
playwriter recorder stop            # stops the recording, prints event count + file path
```

## Phase 2: get the user's summary

Before reading the events, ask the user to briefly describe what they did and to
call out anything non-obvious. Examples of what matters:

- "I clicked the second search result because the first row is always a header"
- "The insurance tab sometimes takes a few seconds to load"
- "The first two clicks were a mistake, ignore them"

This human context is essential for filtering dead ends and adding correct waits.

## Phase 3: inspect the events

Events are a JSON array on disk. `recorder events` prints one JSON object per line for jq. `t` is seconds since recording start and
every event has a sequential `id`. The default output is a **thin timeline**: heavy
payloads (network bodies, snapshot diffs, storage values) are replaced by sizes or key
lists so the full timeline is cheap to read. Pass event ids to get the full details of
specific events. Workflow: skim the thin timeline first, then drill into the few events
you actually need. `recorder events` targets the latest recording by default; pass
`-r <recordingId>` to read an older one.

```bash
# thin timeline: id, time, type, and the most relevant field per event
playwriter recorder events | jq -r '[.id, .t, .type, (.code // .url // .signal // .kind // empty)] | @tsv'

# full details of specific events (untruncated bodies, full snapshot diffs)
playwriter recorder events 4 7 12

# only the recorded actions with their locator code
playwriter recorder events | jq -r 'select(.type == "action") | .code'

# frames folder (one jpeg per visual change, named by timestamp)
playwriter recorder events | jq -r 'select(.framesDir) | .framesDir' | tail -1
ls ~/.playwriter/recordings/<id>/frames/

# mutating xhr/fetch only (POST/PUT/PATCH/DELETE). Thin view shows sizes.
playwriter recorder events | jq -r 'select(.type == "network") | [.id, .method, .status, .url, .responseBodySize] | @tsv'
playwriter recorder events 14 15        # → full request postData + responseBody

# downloads, uploads, console errors
playwriter recorder events | jq 'select(.type == "download" or .type == "file-upload" or .type == "console" or .type == "page-error")'

# escape hatch: full fidelity for the whole timeline (can be very large)
playwriter recorder events --full
```

Event types: `recording-started`, `action` (with `.code` = playwright locator code like
`await page.getByRole('button', { name: 'Submit' }).click()`), `signal` (navigation
committed after an action), `navigation`, `page-opened`, `page-closed`, `network`
(POST/PUT/PATCH/DELETE xhr/fetch only, with truncated `responseBody` for textual
responses), `download` (url + suggested filename), `console` (page console
errors/warnings), `page-error`, `recording-stopped` (includes `framesDir` and
`frameCount`).

Important fields:

- `framesDir` is a folder of jpegs. Chrome only emits a frame when the page
  changes. Files are named `<ms>.jpg` where `ms` is milliseconds since start.
  Every event has the same `ms` field. A pink ripple marks user clicks.
- Frame just before a click: last file whose name is `<=` that action's `ms`.

```bash
FRAMES=$(playwriter recorder events | jq -r 'select(.framesDir) | .framesDir' | tail -1)
# click at ms=8200
ls "$FRAMES" | awk -F'[.-]' '$1+0 <= 8200 { print }' | tail -1
```

- `action.code` uses page aliases: `page` is the first page, `page1`/`page2`/... are
  pages opened later (popups, new tabs). The `pageAlias` field on each action tells you
  which page it targeted. When writing utils functions, map each alias to a function
  parameter or to the popup returned by `context.waitForEvent('page')` — do not paste
  `page1` into code where only `page` exists.
- Network events are mutations only. GET document/xhr/fetch is dropped. Thin view
  shows `postDataSize`/`responseBodySize`; drill into the event id for the values.
- File picks show up as `setInputFiles` actions with the file name. Replay with
  `locator.setInputFiles(path)` and make the path a skill parameter.

## Phase 4: prototype against the live page

Do not trust the recorded locators blindly — verify them before committing them to
the skill. Use the same playwriter session interactively:

```bash
playwriter -s <session> -e "console.log(await snapshot({ page }))"
playwriter -s <session> -e "await page.getByRole('button', { name: 'Submit' }).click()"
```

Loop: snapshot → run one recorded action → snapshot again to confirm the expected
change. Drop actions the user flagged as mistakes. This grounds the skill in what
actually works, instead of guessing.

## Phase 5: ask the user before writing

Ask these in one message. Guess sensible defaults from the recorded events (domains
visited, form fields filled, final success state) and present them as options so the
user only has to confirm:

1. **Skill name** — kebab-case, guess from the workflow (e.g. `submit-to-directory`)
2. **Location** — global (`~/.agents/skills/<name>/`) or project-local (`skills/<name>/` or `.agents/skills/<name>/` in the current repo)
3. **Use case** — one sentence describing when the skill should be used; guess it from the flow
4. **New or update** — if a similar skill already exists (check the location first), ask whether to update it with the newly recorded flow instead of creating a new one
5. **Parameters** — which recorded values should become inputs (values the user typed during the demo should almost always be parameters, not hardcoded) vs stay literal

## Phase 6: write the skill

Create two files in the skill directory:

### `SKILL.md`

Frontmatter with `name` and `description` (description states when to load the skill).
The body explains the flow at a **high level** so an agent can automate it:

- The goal and preconditions, including that playwriter drives an already signed-in browser
- Numbered steps, each referencing the **locator strings** from the recorded `action` events
- For each step, the **expected outcome**: url change, confirmation text, or the
  mutating network request that fires (from `network` events)
- Timing notes the user mentioned ("tab takes seconds to load") mapped to explicit waits
- How to detect overall success (final url, confirmation text in snapshot)
- How to call the utils functions (see below) instead of re-deriving every locator

### `utils.js` (or `utils.ts`)

An importable ESM script with exported functions so replay costs few tokens. The
playwriter sandbox can import local files, so functions should accept `{ page }` (and
parameters) and be called like:

```bash
playwriter -s 1 -e "const { submitProduct } = await import('/abs/path/skills/<name>/utils.js'); await submitProduct({ page, name: 'Acme', url: 'https://acme.com' })"
```

Guidelines for the utils code:

- Use the locators you verified in phase 4 (recorded `.code` fields are the starting
  point — they are generated by playwright's own selector engine)
- After each action, wait for the expected outcome (`page.waitForURL`,
  `locator.waitFor`, or await the network response seen in the events) instead of
  fixed sleeps
- Parameterize the values the user marked as inputs; keep everything else literal
- Keep functions small: one function per logical phase of the flow (e.g. `login`,
  `fillForm`, `submit`), plus one top-level function running the whole flow
- Start with a signed-in check when the flow needs auth: verify a logged-in indicator
  (account button, profile menu) and throw a clear "please log in first" error if
  missing — playwriter drives the user's real browser, so the user logs in manually
- Never hardcode secrets, cookie values, or tokens. If a value must vary per user,
  make it a parameter or read it from an env var
- Handle *expected* nondeterminism narrowly: if the recording or the user mentions a
  cookie banner / popup / modal that sometimes appears, detect it, dismiss it, and
  retry the blocked action once — do not add generic retry loops everywhere
- Throw descriptive errors when an expected outcome doesn't appear, mentioning what
  changed vs what was expected

### Consider network requests instead of UI automation

Check the recorded `network` events. If the data the flow needs comes from clean
fetch/XHR JSON endpoints, calling those APIs is faster and less fragile than driving
the UI: no selectors to maintain, no rendering to wait for. Two safe patterns:

- **In-page fetch**: `page.evaluate(() => fetch(...))` — shares the browser's cookies
  and TLS fingerprint. Use when the site itself calls the endpoint via fetch/XHR.
- **Passive interception**: `page.on('response', ...)` while driving the UI — zero
  extra requests, use when the site has bot protection.

Stay with UI automation when: the site has enterprise bot protection with fetch
monkey-patching, the request is a document/script/image rather than fetch/XHR, or the
data is rendered client-side without a clean API. If unsure, prefer UI automation and
mention the API alternative in SKILL.md.

## Phase 7: validate

The skill is **not done** until the utils replay end-to-end successfully. Run the
top-level function through playwriter with test parameters and verify the output /
end state matches what the user demonstrated. If it fails, re-enter the phase 4
loop (snapshot → exec → fix selector or wait) and run the validation again.

## Updating an existing skill

If the user chose to update an existing skill (or reports a skill is broken):

1. Read the current SKILL.md and utils file first
2. Reproduce the failure or compare recorded locators to the ones in the utils file
3. Snapshot the live page where it breaks and test replacement selectors against it
4. Fix the **root cause**, not the symptom — and if the site changed its markup, check
   the other selectors in the file for the same problem
5. Keep working parts untouched; note in SKILL.md that the flow was re-recorded
6. Re-run the phase 7 validation

## Skill quality checklist

- Locators come from recorded events and were verified against the live page
- Every step has a verifiable expected outcome
- Values typed during the demo are parameters, not hardcoded strings
- Waits reflect real timing (user remarks + recorded event gaps), no blind sleeps
- Secrets are never hardcoded — the skill assumes an already logged-in browser
  session, which is exactly what playwriter provides
- The skill mentions the example invocation command so the next agent can run it
  without reading the utils source
- The full flow was validated end-to-end at least once
