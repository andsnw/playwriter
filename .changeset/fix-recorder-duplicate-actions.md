---
'@xmorse/playwright-core': patch
---

Stop installing a second in-page recorder on the same document.

`extendInjectedScript` can run again after `goBack` (bfcache restore) or
another `InternalFrameNavigatedToNewDocument` on a page that already has
the recorder. The second instance added another click/keydown listener
set, so one user click became two `click` events and one Enter became
two `press` events. Fill stayed one action because Playwright merges
repeated fills.

The injected `PollingRecorder` is now one instance per window.
