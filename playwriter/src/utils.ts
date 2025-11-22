export function getCdpUrl({ port = 19988, host = '127.0.0.1', clientId }: { port?: number; host?: string; clientId?: string } = {}) {
  const id = clientId || Math.random().toString(36).substring(2, 15)
  return `ws://${host}:${port}/cdp/${id}`
}
