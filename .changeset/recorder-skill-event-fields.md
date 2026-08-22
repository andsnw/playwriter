---
'playwriter': minor
---

Record structured fields on each action (`text`, `key`, `options`, `files`, `button`, `modifiers`) so agents do not have to parse locator code.

```bash
playwriter recorder events | jq 'select(.action == "fill") | .text'
# "hi@example.com"
```

Thin `page-error` events now keep `.message`.

Skill generation from a recording is now a **SKILL.md** of markdown steps with example `playwriter -e` commands. `recorder stop` and the toolbar copy prompt start with https://playwriter.dev/SKILL.md so the agent reads how Playwriter works first.
