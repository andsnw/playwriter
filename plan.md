
currently the extension and server code assume there is only one tab attached to debugger only. i want instead to be able to manage multiple tabs. we should update all classes fields that manage tab state to a array  {tabId, dsessionId, targetId}[], then we should send relevant commands to the right chrome.debugger debugee tab, finding the right tab for a specific CDP command (based on sessionId or targetId)

---

now see where attachToTab is sent and received. see that we basically attach to the tab as soon as the playwright instance connects. I want to change this: instead attach to the tab when we click on the extension icon, meaning inside onClicked. when this happens we should also send also a cdp message from the extension Target.attachedToTarget after we are connected. so playwright knows of this new page

now see where we already are sending Target.attachedToTarget. this is now sent setAutoAttach, meaning as soon as playwright connects. let's change this. we should not do anything during setAutoAttach, leave it empty for now.
