# Recording is active — how to turn it into a skill

The user is now performing a workflow manually in their browser. Every click, fill,
keypress, navigation, network request, cookie/storage change, focus change, scroll
and aria snapshot diff is being written to a jsonl file.

The end goal: a **skill** (SKILL.md + importable utils script) that automates the
same flow with playwriter. Follow the phases below in order.

## Phase 1: while the user records

**Wait.** Do not run playwriter commands against this session while recording — it
would pollute the events. While waiting, ask the user (if not already known):

- What is the goal of this workflow, in one sentence?
- What inputs vary between runs (e.g. product name, patient DOB, search query)?
- What is the expected output or end state (data extracted, form submitted, email sent)?

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

Events are jsonl (one JSON object per line). `t` is seconds since recording start and
every event has a sequential `id`. The default output is a **thin timeline**: heavy
payloads (network bodies, snapshot diffs, storage values) are replaced by sizes or key
lists so the full timeline is cheap to read. Pass event ids to get the full details of
specific events. Workflow: skim the thin timeline first, then drill into the few events
you actually need.

```bash
# thin timeline: id, time, type, and the most relevant field per event
playwriter recorder events <id> | jq -r '[.id, .t, .type, (.code // .url // .signal // .kind // empty)] | @tsv'

# full details of specific events (untruncated bodies, full snapshot diffs)
playwriter recorder events <id> 4 7 12

# state changes caused by action 3 (snapshot diff, cookies, storage, focus)
playwriter recorder events <id> | jq 'select(.afterActionId == 3)'

# only the recorded actions with their locator code
playwriter recorder events <id> | jq -r 'select(.type == "action") | .code'

# find the site's JSON APIs: thin view shows sizes, then drill into the ids
playwriter recorder events <id> | jq -r 'select(.type == "network" and .responseBodySize) | [.id, .method, .status, .url, .responseBodySize] | @tsv'
playwriter recorder events <id> 14 15   # → full request postData + responseBody

# downloads, uploads, console errors
playwriter recorder events <id> | jq 'select(.type == "download" or .type == "file-upload" or .type == "console" or .type == "page-error")'

# cookie / storage changes (login state, tokens, feature flags)
playwriter recorder events <id> | jq 'select(.type == "cookies" or .type == "storage")'

# snapshot-diff previews are in the thin view; drill into an id for the full diff
playwriter recorder events <id> | jq -r 'select(.type == "snapshot-diff") | [.id, .preview] | @tsv'

# escape hatch: full fidelity for the whole timeline (can be very large)
playwriter recorder events <id> --full
```

Event types: `recording-started`, `action` (with `.code` = playwright locator code like
`await page.getByRole('button', { name: 'Submit' }).click()`), `signal` (navigation
committed after an action), `navigation`, `url-changed` (SPA pushState), `page-opened`,
`page-closed`, `network` (with truncated `responseBody` for textual xhr/fetch responses),
`download` (url + suggested filename), `file-upload` (file names chosen in
`input[type=file]`), `console` (page console errors/warnings), `page-error`, `cookies`,
`storage`, `focus`, `scroll`, `snapshot-diff`, `recording-stopped`.

Important fields:

- Each `action` event has an `actionId`. State-change events (`snapshot-diff`,
  `cookies`, `storage`, `focus`) carry `afterActionId` linking them to the action that
  caused them. Captures run asynchronously, so use `afterActionId` (not line order) to
  associate state changes with actions.
- `action.code` uses page aliases: `page` is the first page, `page1`/`page2`/... are
  pages opened later (popups, new tabs). The `pageAlias` field on each action tells you
  which page it targeted. When writing utils functions, map each alias to a function
  parameter or to the popup returned by `context.waitForEvent('page')` — do not paste
  `page1` into code where only `page` exists.
- `cookies` events list cookie identities (`name|domain|path`) only; values are never
  stored (change detection uses hashes). In the thin view, storage diffs show `addedKeys`/
  `changedKeys` and network events show `postDataSize`/`responseBodySize`; drill into the
  event id for the actual values.
- A native file chooser shows up as a `fill` action with a fake `C:\fakepath\...` value;
  ignore that action and use the `file-upload` event's real file names instead. Replay
  uploads with `locator.setInputFiles(path)` and make the path a skill parameter.

## Phase 4: prototype against the live page

Do not trust the recorded locators blindly — verify them before committing them to
the skill. Use the same playwriter session interactively:

```bash
playwriter -s <session> -e "console.log(await snapshot({ page }))"
playwriter -s <session> -e "await page.getByRole('button', { name: 'Submit' }).click()"
```

Loop: snapshot → run one recorded action → snapshot again to confirm the expected
change (compare with the recorded `snapshot-diff` for that action). Drop actions the
user flagged as mistakes. This grounds the skill in what actually works, instead of
guessing.

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

- The goal and preconditions — including login state: which cookies/storage keys
  indicate the user is signed in (take them from the `cookies`/`storage` events)
- Numbered steps, each referencing the **locator strings** from the recorded `action` events
- For each step, the **expected outcome**: url change, key lines from the snapshot diff,
  or the network request that fires (from `network` events) — this is how the automating
  agent verifies the step worked
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
