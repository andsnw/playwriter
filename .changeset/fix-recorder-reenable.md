---
'@xmorse/playwright-core': patch
---

Fix re-enabling the headless recorder (`recorderMode: 'api'`) after `_disableRecorder()`. Previously the cached server recorder stayed in mode `none`, so a second recording on the same context captured no actions, and each re-enable attached duplicate event listeners that would double recorded actions. Now re-enabling restores the requested mode on the existing recorder without attaching new listeners.
