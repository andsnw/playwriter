---
'playwriter': patch
---

Skip analytics collectors when recording network requests in a skill
recording.

Mutating `xhr`/`fetch` requests are dropped when the request hostname is a
known telemetry host (Google Analytics, Google Tag Manager, DoubleClick,
Hotjar, Mixpanel, Segment, FullStory, Amplitude, Clarity). A Hacker News
recording used to be mostly `POST https://www.google-analytics.com/j/collect`
noise; those events are gone now.

Matching is on the **hostname only**, so a site API is kept even when the
path or the query string mentions analytics:

```js
isTelemetryUrl('https://region1.google-analytics.com/g/collect?v=2') // true
isTelemetryUrl('https://example.com/api?next=https://analytics.example') // false
```
