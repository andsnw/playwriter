/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Protocol } from 'playwriter/src/cdp-types';
import type { ExtensionCommandMessage, ExtensionResponseMessage } from 'playwriter/src/extension/protocol';

export function debugLog(...args: unknown[]): void {
  const enabled = true;
  if (enabled) {
    // eslint-disable-next-line no-console
    console.log('[Extension]', ...args);
  }
}

interface AttachedTab {
  debuggee: chrome.debugger.Debuggee;
  targetId: string;
  sessionId: string;
  targetInfo: Protocol.Target.TargetInfo;
  // Cache execution contexts for this tab. When Playwright reconnects and calls Runtime.enable,
  // Chrome's debugger does NOT re-send Runtime.executionContextCreated events for contexts that
  // already exist. We must manually replay them so Playwright knows what contexts are available.
  // Without this, page.evaluate() hangs because Playwright has no valid execution context IDs.
  executionContexts: Map<number, Protocol.Runtime.ExecutionContextCreatedEvent>;
}

export class RelayConnection {
  private _attachedTabs: Map<number, AttachedTab> = new Map();
  private _nextSessionId: number = 1;
  private _ws: WebSocket;
  private _closed = false;
  private _onCloseCallback?: () => void;
  private _onTabDetachedCallback?: (tabId: number, reason: `${chrome.debugger.DetachReason}`) => void

  constructor({ ws, onClose, onTabDetached }: {
    ws: WebSocket;
    onClose?: () => void;
    onTabDetached?: (tabId: number, reason: `${chrome.debugger.DetachReason}`) => void;
  }) {
    this._ws = ws;
    this._onCloseCallback = onClose;
    this._onTabDetachedCallback = onTabDetached;
    this._ws.onmessage = async (event: MessageEvent) => {
      let message: ExtensionCommandMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error: any) {
        debugLog('Error parsing message:', error);
        this._sendMessage({
          error: {
            code: -32700,
            message: `Error parsing message: ${error.message}`,
          },
        });
        return;
      }

      debugLog('Received message:', message);

      const response: ExtensionResponseMessage = {
        id: message.id,
      };
      try {
        response.result = await this._handleCommand(message);
      } catch (error: any) {
        debugLog('Error handling command:', error);
        response.error = error.message;
      }
      debugLog('Sending response:', response);
      this._sendMessage(response);
    };
    this._ws.onclose = (event: CloseEvent) => {
      debugLog('WebSocket onclose event:', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      });
      this._onClose();
    };
    this._ws.onerror = (event: Event) => {
      debugLog('WebSocket onerror event:', event);
    };
    chrome.debugger.onEvent.addListener(this._onDebuggerEvent);
    chrome.debugger.onDetach.addListener(this._onDebuggerDetach);
    debugLog('RelayConnection created, WebSocket readyState:', this._ws.readyState);
  }

  async attachTab(tabId: number): Promise<Protocol.Target.TargetInfo> {
    const debuggee = { tabId };

    debugLog('Attaching debugger to tab:', tabId, 'WebSocket state:', this._ws.readyState);

    try {
      await chrome.debugger.attach(debuggee, '1.3');
      debugLog('Debugger attached successfully to tab:', tabId);
    } catch (error: any) {
      debugLog('ERROR attaching debugger to tab:', tabId, error);
      throw error;
    }

    debugLog('Sending Target.getTargetInfo command for tab:', tabId);
    const result = await chrome.debugger.sendCommand(
      debuggee,
      'Target.getTargetInfo'
    ) as Protocol.Target.GetTargetInfoResponse;

    debugLog('Received targetInfo for tab:', tabId, result.targetInfo);

    const targetInfo = result.targetInfo;
    const sessionId = `pw-tab-${this._nextSessionId++}`;

    this._attachedTabs.set(tabId, {
      debuggee,
      targetId: targetInfo.targetId,
      sessionId,
      targetInfo,
      executionContexts: new Map()
    });

    debugLog('Sending Target.attachedToTarget event, WebSocket state:', this._ws.readyState);
    this._sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: {
            ...targetInfo,
            attached: true
          },
          waitingForDebugger: false
        }
      }
    });

    debugLog('Tab attached successfully:', tabId, 'sessionId:', sessionId, 'targetId:', targetInfo.targetId);
    return targetInfo;
  }

  detachTab(tabId: number): void {
    const tab = this._attachedTabs.get(tabId);
    if (!tab) {
      debugLog('detachTab: tab not found in map:', tabId);
      return;
    }

    debugLog('Detaching tab:', tabId, 'sessionId:', tab.sessionId);

    this._sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: tab.sessionId,
          targetId: tab.targetId
        }
      }
    });

    this._attachedTabs.delete(tabId);
    debugLog('Removed tab from _attachedTabs map. Remaining tabs:', this._attachedTabs.size);

    chrome.debugger.detach(tab.debuggee)
      .then(() => {
        debugLog('Successfully detached debugger from tab:', tabId);
      })
      .catch((err) => {
        debugLog('Error detaching debugger from tab:', tabId, err.message);
      });
  }

  close(message: string): void {
    debugLog('Closing RelayConnection, reason:', message, 'current state:', this._ws.readyState);
    this._ws.close(1000, message);
    this._onClose();
  }

  private _onClose() {
    if (this._closed) {
      debugLog('_onClose called but already closed');
      return;
    }

    debugLog('Connection closing, attached tabs count:', this._attachedTabs.size);
    this._closed = true;


    chrome.debugger.onEvent.removeListener(this._onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(this._onDebuggerDetach);

    const tabIds = Array.from(this._attachedTabs.keys());
    debugLog('Detaching all tabs:', tabIds);

    for (const [tabId, tab] of this._attachedTabs) {
      debugLog('Detaching debugger from tab:', tabId);
      chrome.debugger.detach(tab.debuggee)
        .then(() => {
          debugLog('Successfully detached from tab:', tabId);
        })
        .catch((err) => {
          debugLog('Error detaching from tab:', tabId, err.message);
        });
    }

    this._attachedTabs.clear();
    debugLog('All tabs cleared from map. Chrome automation bar should disappear in a few seconds.');

    debugLog('Connection closed, calling onClose callback');
    this._onCloseCallback?.();
  }

  private _onDebuggerEvent = (source: chrome.debugger.DebuggerSession, method: string, params: any): void => {
    const tab = this._attachedTabs.get(source.tabId!);
    if (!tab) return;

    // Track execution contexts so we can replay them when Playwright reconnects.
    // Chrome's debugger only sends Runtime.executionContextCreated events once per context,
    // not on every Runtime.enable call. We cache them here and replay on reconnection.
    if (method === 'Runtime.executionContextCreated') {
      const contextEvent = params as Protocol.Runtime.ExecutionContextCreatedEvent;
      tab.executionContexts.set(contextEvent.context.id, contextEvent);
      debugLog('Cached execution context:', contextEvent.context.id, 'for tab:', source.tabId, 'total contexts:', tab.executionContexts.size);
    } else if (method === 'Runtime.executionContextDestroyed') {
      const destroyedEvent = params as Protocol.Runtime.ExecutionContextDestroyedEvent;
      tab.executionContexts.delete(destroyedEvent.executionContextId);
      debugLog('Removed execution context:', destroyedEvent.executionContextId, 'from tab:', source.tabId, 'remaining:', tab.executionContexts.size);
    } else if (method === 'Runtime.executionContextsCleared') {
      tab.executionContexts.clear();
      debugLog('Cleared all execution contexts for tab:', source.tabId);
    }

    debugLog('Forwarding CDP event:', method, 'from tab:', source.tabId);

    this._sendMessage({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  };

  private _onDebuggerDetach = (source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`): void => {
    const tabId = source.tabId;
    debugLog('_onDebuggerDetach called for tab:', tabId, 'reason:', reason, 'isAttached:', tabId ? this._attachedTabs.has(tabId) : false);

    if (!tabId || !this._attachedTabs.has(tabId)) {
      debugLog('Ignoring debugger detach event for untracked tab:', tabId);
      return;
    }

    debugLog(`Manual debugger detachment detected for tab ${tabId}: ${reason}`);
    debugLog('User closed debugger via Chrome automation bar, calling onTabDetached callback');
    this._onTabDetachedCallback?.(tabId, reason);

    this.detachTab(tabId);
  };

  private async _handleCommand(message: ExtensionCommandMessage): Promise<any> {
    if (message.method === 'attachToTab') {
      return {};
    }

    if (message.method === 'activateTab') {
      const { targetId } = message.params;
      debugLog('Activating tab with targetId:', targetId);

      for (const [tabId, tab] of this._attachedTabs) {
        if (tab.targetId === targetId) {
          debugLog('Found tab to activate:', tabId);
          await chrome.tabs.update(tabId, { active: true });
          // const chromeTab = await chrome.tabs.get(tabId);
          // if (chromeTab.windowId) {
          //   await chrome.windows.update(chromeTab.windowId, { focused: true });
          // }
          return { success: true };
        }
      }

      debugLog('Target not found:', targetId);
      throw new Error(`Target not found: ${targetId}`);
    }

    if (message.method === 'forwardCDPCommand') {
      const { sessionId, method, params } = message.params;

      if (method === 'Target.createTarget') {
        const url = params?.url || 'about:blank';
        debugLog('Creating new tab with URL:', url);

        const tab = await chrome.tabs.create({ url, active: false });
        if (!tab.id) {
          throw new Error('Failed to create tab');
        }

        debugLog('Created tab:', tab.id, 'waiting for it to load...');

        // Wait a bit for tab to initialize
        await new Promise(resolve => setTimeout(resolve, 100));

        // Attach to the new tab
        const targetInfo = await this.attachTab(tab.id);

        return { targetId: targetInfo.targetId };
      }

      if (method === 'Target.closeTarget' && params?.targetId) {
        debugLog('Closing target:', params.targetId);

        for (const [tabId, tab] of this._attachedTabs) {
          if (tab.targetId === params.targetId) {
            debugLog('Found tab to close:', tabId);
            await chrome.tabs.remove(tabId);
            return { success: true };
          }
        }

        debugLog('Target not found:', params.targetId);
        throw new Error(`Target not found: ${params.targetId}`);
      }

      let targetTab: AttachedTab | undefined;

      for (const [tabId, tab] of this._attachedTabs) {
        if (tab.sessionId === sessionId) {
          targetTab = tab;
          break;
        }
      }

      if (!targetTab) {
        if (method === 'Browser.getVersion' || method === 'Target.getTargets') {
          targetTab = this._attachedTabs.values().next().value;
        }

        if (!targetTab) {
          throw new Error(`No tab found for sessionId: ${sessionId}`);
        }
      }

      debugLog('CDP command:', method, 'for tab:', targetTab.debuggee.tabId);

      const debuggerSession: chrome.debugger.DebuggerSession = {
        ...targetTab.debuggee,
        sessionId: sessionId !== targetTab.sessionId ? sessionId : undefined,
      };

      const result = await chrome.debugger.sendCommand(
        debuggerSession,
        method,
        params
      );

      // When Playwright reconnects and calls Runtime.enable, Chrome does NOT automatically
      // re-send Runtime.executionContextCreated events for contexts that already exist.
      // This causes page.evaluate() to hang because Playwright has no execution context IDs.
      // Solution: manually replay all cached contexts so Playwright gets fresh, valid IDs.
      if (method === 'Runtime.enable' && targetTab.executionContexts.size > 0) {
        debugLog('Runtime.enable called, replaying', targetTab.executionContexts.size, 'cached execution contexts for tab:', targetTab.debuggee.tabId);

        for (const contextEvent of targetTab.executionContexts.values()) {
          debugLog('Replaying execution context:', contextEvent.context.id);
          this._sendMessage({
            method: 'forwardCDPEvent',
            params: {
              sessionId: sessionId,
              method: 'Runtime.executionContextCreated',
              params: contextEvent,
            },
          });
        }
      }

      return result;
    }
  }

  private _sendMessage(message: any): void {
    if (this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify(message));
        debugLog('Message sent successfully, type:', message.method || 'response');
      } catch (error: any) {
        debugLog('ERROR sending message:', error, 'message type:', message.method || 'response');
      }
    } else {
      debugLog('Cannot send message, WebSocket not open. State:', this._ws.readyState, 'message type:', message.method || 'response');
    }
  }
}
