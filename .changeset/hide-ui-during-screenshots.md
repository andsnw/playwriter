---
'playwriter': patch
---

Hide playwriter UI elements (toolbar, overlay, ghost cursor), scrollbars, and blinking caret during `Page.captureScreenshot` CDP commands. A `playwriter-screenshot` class is toggled on `<html>` around the capture, activating persistent CSS that hides these elements. Works for all CDP clients.
