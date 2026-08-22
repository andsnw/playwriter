---
'playwriter': patch
---

Teach the recorder prompt to turn a recorded JSON API into an in-page class SDK. The skill calls `fetch` inside `page.evaluate` so cookies and captchas stay in the real tab. Methods take one object argument. Failed requests throw with method, path, status, and response text.

```js
const client = new DirectoryClient({ page })
await client.submitProduct({ name: 'Acme', url: 'https://acme.com' })
```
