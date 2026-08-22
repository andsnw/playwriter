---
'playwriter': minor
---

Clicking the extension icon while the local daemon is down now opens a short tutorial tab instead of sitting on a gray or orange badge.

The page explains that the first `playwriter` command starts the daemon, and shows how to do that yourself:

```bash
npm i -g playwriter
npx -y skills add https://playwriter.dev

playwriter session new
playwriter -s 1 -e "const p = await context.newPage(); await p.goto('https://example.com')"
```

Or ask an agent to use the browser, then click the icon on a normal website tab to attach that tab. A second click focuses the existing tutorial tab instead of opening another one.
