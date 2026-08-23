---
'playwriter': patch
---

Cap active skill recordings at **10**.

`POST /recorder/start` is open to any page so the toolbar Record button works. A site can start or stop a recording. It cannot read events or run code. The new cap stops a page from opening unbounded CDP screencasts.

The 11th start returns **429**:

```text
Too many active recordings (10). Stop one first.
```
