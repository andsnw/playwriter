---
'@xmorse/playwright-core': patch
'playwriter': patch
---

Make `playwriter recorder` much faster and fix the recorded timeline.

API-mode recording no longer walks the full page ARIA tree on every click, fill, or keypress. Those walks ran **twice** inside the click handler and blocked the tab for **500–700ms** per click (measured on Hacker News). Playwriter already captures a snapshot **after** the action, so the injected trees were unused.

Also:

- Clicks and navigations write immediately. Only `fill` waits to coalesce keystrokes. Before, every action waited 800ms, so the click appeared **after** the navigation it caused.
- Cookie diffs work in extension mode. `context.cookies()` fails there (`Storage.getCookies` has no browser session); the recorder now reads cookies via `Network.getCookies` on the page CDP session.
- Icon-font glyphs are stripped from locator names, so a login button records as `getByRole('button', { name: 'Login' })` instead of `name: ' Login'`.
