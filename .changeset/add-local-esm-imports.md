---
'playwriter': minor
---

Add native Node.js dynamic imports to execute calls.

Playwriter now compiles execute calls with `vm.Script` and configures Node's main-context ESM loader through `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`. This replaces the `vm.runInContext()` shortcut that rejected `import()` with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.

Relative modules resolve from the Playwriter session working directory. Imported scripts use normal Node.js resolution and permissions, can use static imports and package dependencies, and can receive Playwright objects as function arguments.

```js
const { inspectPage } = await import('./scripts/inspect-page.mjs')
console.log(await inspectPage({ page }))
```

Sandboxed `require()` and `importModule()` remain available for restricted access to allowlisted Node.js built-ins.
