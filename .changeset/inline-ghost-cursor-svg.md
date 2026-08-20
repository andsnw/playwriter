---
'playwriter': patch
---

Render the ghost cursor as an inline `<svg>` element instead of a
`data:image/svg+xml` CSS background.

Sites with a strict `img-src` Content Security Policy (Hacker News, for
example) blocked the background image and logged a console error on every
navigation:

```
Refused to load the image 'data:image/svg+xml;base64,…' because it
violates the following Content Security Policy directive: "img-src …"
```

The cursor markup is now parsed with `DOMParser` and appended to the
cursor element, so no image URL is involved and no CSP rule applies. The
`screenstudio` and `minimal` cursor styles look the same as before.
