---
'playwriter': patch
---

Block `process.getBuiltinModule()` and `import()` sandbox escapes.

`process.getBuiltinModule('node:child_process')` and `globalThis.import('node:child_process')` bypassed the `ALLOWED_MODULES` allowlist, giving sandboxed code unrestricted access to `child_process`, `fs` (unsandboxed), and every other Node.js built-in. Both now go through the same allowlist and `ScopedFS` interception as `require()`.

Fixes #105
