export const VERSION = 1

export type ExtensionCommandMessage =
  | {
      id: number
      method: 'attachToTab'
      params?: object
    }
  | {
      id: number
      method: 'forwardCDPCommand'
      params: {
        method: string
        sessionId?: string
        params?: any
      }
    }
  | {
      id: number
      method: 'activateTab'
      params: {
        targetId: string
      }
    }

export type ExtensionResponseMessage = {
  id: number
  result?: any
  error?: string
}

export type ExtensionEventMessage = {
  method: 'forwardCDPEvent'
  params: {
    method: string
    sessionId?: string
    params?: any
  }
}

export type ExtensionMessage = ExtensionResponseMessage | ExtensionEventMessage
