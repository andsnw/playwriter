import { startPlayWriterCDPRelayServer } from './extension/cdp-relay.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import util from 'node:util'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const logFilePath = path.join(__dirname, '..', 'relay-server.log')

fs.writeFileSync(logFilePath, '')

const log = (...args: any[]) => {
  const message = args.map(arg =>
    typeof arg === 'string' ? arg : util.inspect(arg, { depth: null, colors: false })
  ).join(' ')
  fs.appendFileSync(logFilePath, message + '\n')
}

const logger = {
  log,
  error: log
}

export async function startServer({ port = 19988 }: { port?: number } = {}) {
  const server = await startPlayWriterCDPRelayServer({ port, logger })

  console.log('CDP Relay Server running. Press Ctrl+C to stop.')
  console.log('Logs are being written to:', logFilePath)

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    server.close()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('\nShutting down...')
    server.close()
    process.exit(0)
  })

  return server
}
startServer().catch(logger.error)
