---
'playwriter': patch
---

The in-page **Record** button no longer fails when many playwriter sessions are open. The relay attaches to a free extension session, or creates one. Session pick does not matter: extension sessions share the same Chrome tabs.

`playwriter recorder stop` without an id still stops the only active recording. If **more than one** recording is active, it now throws and lists each recording with its current or last page URL so the agent can pick or ask you:

```
Multiple active recordings. Pass a recording id.

  3  session 1  https://app.example.com/settings
  5  session 2  https://github.com/remorses/playwriter
```

```bash
playwriter recorder status
playwriter recorder stop 3
```

The toolbar Stop button sends the recording id it started, so it is never ambiguous.
