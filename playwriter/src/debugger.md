# JavaScript Debugging with CDP

You can use the Chrome DevTools Protocol (CDP) Debugger domain to debug JavaScript in the browser. This allows you to set breakpoints, step through code, inspect variables, and examine stack traces.

## Getting Started

Use `getCDPSession` to access CDP commands:

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.enable');
```

Always enable the debugger before using other debugger commands.

## Listing Scripts on the Page

Use `Page.getResourceTree` to list all loaded resources including scripts:

```js
const cdp = await getCDPSession({ page });
const tree = await cdp.send('Page.getResourceTree');
const scripts = tree.frameTree.resources.filter(r => r.type === 'Script');
scripts.forEach(s => { console.log(s.url); });
```

The response structure:

```js
{
  "frameTree": {
    "frame": {
      "id": "FRAME_ID",
      "url": "https://example.com/page",
      "securityOrigin": "https://example.com",
      "mimeType": "text/html"
    },
    "resources": [
      {
        "url": "https://example.com/app.js",
        "type": "Script",              // Script, Image, Font, Stylesheet, etc.
        "mimeType": "text/javascript",
        "contentSize": 78679,          // size in bytes
        "lastModified": 1765390319     // timestamp
      }
    ]
  }
}
```

Filter to find app scripts (exclude libraries):

```js
const cdp = await getCDPSession({ page });
const tree = await cdp.send('Page.getResourceTree');
const scripts = tree.frameTree.resources.filter(r => r.type === 'Script' && !r.url.includes('vendor') && !r.url.includes('node_modules'));
scripts.forEach(s => { console.log(`${(s.contentSize / 1024).toFixed(1)}KB - ${s.url.split('/').pop()}`); });
```

## Understanding Call Frames

When the debugger pauses, you get an array of **call frames** representing the call stack. Frame 0 is where execution paused, frame 1 is the function that called it, frame 2 called frame 1, and so on.

Example: If you have `outer()` → `middle()` → `inner()` → `debugger`, you'll see:

```
#0 inner      ← where we paused
#1 middle     ← called inner()
#2 outer      ← called middle()
#3 (anonymous) ← top-level code that called outer()
```

### Call Frame Structure

Each call frame contains:

```js
{
  "callFrameId": "-4687593592348163175.1.0",  // ID for evaluating in this frame
  "functionName": "inner",                     // function name (empty for anonymous)
  "canBeRestarted": true,                      // can restart from this frame
  "location": {
    "scriptId": "1104",
    "lineNumber": 0,
    "columnNumber": 116
  },
  "functionLocation": {                        // where function is defined
    "scriptId": "1104",
    "lineNumber": 0,
    "columnNumber": 110
  },
  "scopeChain": [                              // variables in scope
    {
      "type": "local",                         // local, closure, global, block, catch, etc.
      "name": "inner",
      "object": { "objectId": "..." }          // use Runtime.getProperties to inspect
    },
    { "type": "closure", "object": { "objectId": "..." } },
    { "type": "global", "object": { "objectId": "..." } }
  ],
  "this": {                                    // 'this' value in this frame
    "type": "object",
    "className": "Window"
  }
}
```

### Inspecting the Call Stack

Print the full call stack when paused:

```js
state.lastPause.callFrames.forEach((frame, i) => {
  console.log(`#${i} ${frame.functionName || '(anonymous)'} at line ${frame.location.lineNumber}`);
  console.log(`   Scopes: ${frame.scopeChain.map(s => s.type).join(', ')}`);
});
```

### Getting Local Variables from a Frame

```js
const cdp = await getCDPSession({ page });
const frame = state.lastPause.callFrames[0];
const localScope = frame.scopeChain.find(s => s.type === 'local');
const props = await cdp.send('Runtime.getProperties', { objectId: localScope.object.objectId });
props.result.forEach(p => { console.log(`${p.name} = ${p.value?.value}`); });
```

### Evaluating in Different Frames

You can evaluate expressions in any frame, not just the current one:

```js
const cdp = await getCDPSession({ page });
// Evaluate in the parent frame (frame 1)
const parentFrameId = state.lastPause.callFrames[1].callFrameId;
const result = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: parentFrameId, expression: 'myVar' });
console.log('Value in parent frame:', result.result.value);
```

## Example Flows

### Flow 1: Catch a `debugger` Statement in Code

If the site has `debugger;` statements or you want to pause on them:

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.enable');
state.pauseHandler = (event) => { state.lastPause = event; };
cdp.on('Debugger.paused', state.pauseHandler);
```

Then trigger the code that contains `debugger;`. After it pauses:

```js
console.log('Paused at:', state.lastPause.callFrames[0].location);
console.log('Reason:', state.lastPause.reason);
```

Resume execution:

```js
const cdp = await getCDPSession({ page }); await cdp.send('Debugger.resume');
```

### Flow 2: Set a Breakpoint by URL and Line Number

Set a breakpoint in a specific file:

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.enable');
const result = await cdp.send('Debugger.setBreakpointByUrl', { lineNumber: 42, urlRegex: '.*app\\.js$' });
console.log('Breakpoint ID:', result.breakpointId);
console.log('Resolved locations:', result.locations);
```

### Flow 3: Pause on Exceptions

Catch all exceptions (or only uncaught ones):

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.enable');
await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' }); // 'none', 'caught', 'uncaught', 'all'
state.pauseHandler = (event) => { state.lastPause = event; };
cdp.on('Debugger.paused', state.pauseHandler);
```

Now when an exception is thrown, the debugger pauses. Check what happened:

```js
console.log('Exception paused:', state.lastPause.reason);
console.log('Data:', JSON.stringify(state.lastPause.data, null, 2));
```

### Flow 4: Inspect the Call Stack

When paused, examine the stack trace:

```js
const frames = state.lastPause.callFrames;
frames.forEach((frame, i) => {
  console.log(`#${i} ${frame.functionName || '(anonymous)'} at ${frame.url}:${frame.location.lineNumber}:${frame.location.columnNumber}`);
});
```

### Flow 5: Evaluate Variables in a Paused Frame

When paused, you can evaluate expressions in any call frame:

```js
const cdp = await getCDPSession({ page });
const frameId = state.lastPause.callFrames[0].callFrameId;
const result = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: 'myVariable' });
console.log('Value:', result.result.value);
console.log('Type:', result.result.type);
```

Evaluate complex expressions:

```js
const cdp = await getCDPSession({ page });
const frameId = state.lastPause.callFrames[0].callFrameId;
const result = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: 'JSON.stringify({ user, config, state })' });
console.log('Context:', result.result.value);
```

### Flow 6: Inspect Scope Variables

Each call frame has a scope chain. List all variables in scope:

```js
const frame = state.lastPause.callFrames[0];
frame.scopeChain.forEach((scope, i) => {
  console.log(`Scope ${i}: ${scope.type} ${scope.name || ''}`);
});
```

To get variables from a specific scope, use `Runtime.getProperties` on the scope's object:

```js
const cdp = await getCDPSession({ page });
const localScope = state.lastPause.callFrames[0].scopeChain.find(s => s.type === 'local');
if (localScope) {
  const props = await cdp.send('Runtime.getProperties', { objectId: localScope.object.objectId });
  props.result.forEach(p => { console.log(`  ${p.name}: ${p.value?.value ?? p.value?.type}`); });
}
```

### Flow 7: Step Through Code

When paused, use stepping commands:

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.stepOver');  // Execute current line, don't enter functions
await cdp.send('Debugger.stepInto');  // Step into function calls
await cdp.send('Debugger.stepOut');   // Run until current function returns
```

After each step, the `Debugger.paused` event fires again with the new location.

### Flow 8: Get Script Source

When you see a scriptId in the pause event, get its source:

```js
const cdp = await getCDPSession({ page });
const scriptId = state.lastPause.callFrames[0].location.scriptId;
const source = await cdp.send('Debugger.getScriptSource', { scriptId });
const lines = source.scriptSource.split('\n');
const line = state.lastPause.callFrames[0].location.lineNumber;
console.log('Current line:', lines[line]);
console.log('Context:', lines.slice(Math.max(0, line - 3), line + 4).join('\n'));
```

### Flow 9: Search in Script Content

Find where a function or variable is used:

```js
const cdp = await getCDPSession({ page });
const scriptId = state.lastPause.callFrames[0].location.scriptId;
const matches = await cdp.send('Debugger.searchInContent', { scriptId, query: 'handleClick', isRegex: false });
matches.result.forEach(m => { console.log(`Line ${m.lineNumber}: ${m.lineContent}`); });
```

### Flow 10: Watch a Variable Across Steps

Store variable values as you step through:

```js
state.watchedValues = state.watchedValues || [];
const cdp = await getCDPSession({ page });
const frameId = state.lastPause.callFrames[0].callFrameId;
const result = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: 'counter' });
state.watchedValues.push({ line: state.lastPause.callFrames[0].location.lineNumber, value: result.result.value });
console.log('Watch history:', state.watchedValues);
```

### Flow 11: Modify a Variable at Runtime

Change a variable's value while paused:

```js
const cdp = await getCDPSession({ page });
const frameId = state.lastPause.callFrames[0].callFrameId;
await cdp.send('Debugger.setVariableValue', {
  scopeNumber: 0,  // 0 = local scope
  variableName: 'shouldRetry',
  newValue: { value: true },
  callFrameId: frameId
});
console.log('Variable modified');
```

### Flow 12: Skip All Pauses Temporarily

Disable breakpoints without removing them:

```js
const cdp = await getCDPSession({ page }); await cdp.send('Debugger.setSkipAllPauses', { skip: true });
```

Re-enable:

```js
const cdp = await getCDPSession({ page }); await cdp.send('Debugger.setSkipAllPauses', { skip: false });
```

### Flow 13: Blackbox Third-Party Scripts

Skip stepping into library code (e.g., React, lodash):

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.setBlackboxPatterns', { patterns: ['.*node_modules.*', '.*vendor.*', '.*react.*'] });
```

### Flow 14: Continue to a Specific Location

Instead of stepping line by line, jump to a specific location:

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.continueToLocation', {
  location: { scriptId: 'your-script-id', lineNumber: 100 },
  targetCallFrames: 'any'
});
```

## Complete Debugging Session Example

Here's a full example debugging a button click handler:

**Step 1: Enable debugger and set up pause listener**

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.enable');
await cdp.send('Debugger.setPauseOnExceptions', { state: 'uncaught' });
state.pauseHandler = (event) => { state.lastPause = event; console.log('PAUSED:', event.reason, 'at line', event.callFrames[0]?.location?.lineNumber); };
cdp.on('Debugger.paused', state.pauseHandler);
```

**Step 2: Set breakpoint on the handler**

```js
const cdp = await getCDPSession({ page });
const bp = await cdp.send('Debugger.setBreakpointByUrl', { lineNumber: 25, urlRegex: '.*handleSubmit.*' });
console.log('Breakpoint set:', bp.breakpointId);
```

**Step 3: Trigger the action (click the button)**

```js
await page.click('#submit-button');
```

**Step 4: When paused, inspect state**

```js
const cdp = await getCDPSession({ page });
const frameId = state.lastPause.callFrames[0].callFrameId;
const formData = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: 'JSON.stringify(formData)' });
console.log('Form data at breakpoint:', formData.result.value);
```

**Step 5: Step through and watch**

```js
const cdp = await getCDPSession({ page }); await cdp.send('Debugger.stepOver');
```

**Step 6: Check new state after step**

```js
const cdp = await getCDPSession({ page });
const frameId = state.lastPause.callFrames[0].callFrameId;
const result = await cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: 'validationResult' });
console.log('Validation result:', result.result.value);
```

**Step 7: Resume and clean up**

```js
const cdp = await getCDPSession({ page });
await cdp.send('Debugger.resume');
await cdp.send('Debugger.disable');
cdp.off('Debugger.paused', state.pauseHandler);
```

## CDP Debugger Command Reference

| Command | Description |
|---------|-------------|
| `Debugger.enable` | Enable debugging (required first) |
| `Debugger.disable` | Disable debugging |
| `Debugger.pause` | Pause execution immediately |
| `Debugger.resume` | Resume execution |
| `Debugger.stepOver` | Step over current statement |
| `Debugger.stepInto` | Step into function call |
| `Debugger.stepOut` | Step out of current function |
| `Debugger.setBreakpoint` | Set breakpoint at exact location |
| `Debugger.setBreakpointByUrl` | Set breakpoint by URL pattern |
| `Debugger.removeBreakpoint` | Remove a breakpoint |
| `Debugger.setPauseOnExceptions` | Pause on exceptions: `none`, `caught`, `uncaught`, `all` |
| `Debugger.evaluateOnCallFrame` | Evaluate expression in a frame |
| `Debugger.setVariableValue` | Modify variable value |
| `Debugger.getScriptSource` | Get script source code |
| `Debugger.searchInContent` | Search in script |
| `Debugger.setSkipAllPauses` | Temporarily disable all breakpoints |
| `Debugger.setBlackboxPatterns` | Skip stepping into matching scripts |

## Events

| Event | Description |
|-------|-------------|
| `Debugger.paused` | VM paused (breakpoint, exception, step) |
| `Debugger.resumed` | VM resumed execution |
| `Debugger.scriptParsed` | New script was parsed |
| `Debugger.scriptFailedToParse` | Script parsing failed |

## Tips

- Always call `Debugger.enable` before other debugger commands
- Store pause events in `state.lastPause` to inspect them in subsequent calls
- Use `Debugger.setBlackboxPatterns` to skip library code when stepping
- Clean up event listeners with `cdp.off()` when done debugging
- The `callFrameId` is only valid while paused - use it immediately
- Use `Debugger.evaluateOnCallFrame` with `JSON.stringify()` for complex objects
