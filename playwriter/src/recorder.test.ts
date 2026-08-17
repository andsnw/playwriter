// End-to-end tests for the `playwriter recorder` action recording feature:
// relay /recorder/* endpoints + ActionRecorder JSON output. Trusted input is
// dispatched via raw CDP so it goes through the injected recorder exactly
// like real user interactions.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@xmorse/playwright-core'
import { getCdpUrl } from './utils.js'
import { getCDPSessionForPage } from './cdp-session.js'
import { parseRecording, projectThinEvent } from './action-recorder.js'
import { setupTestContext, cleanupTestContext, getExtensionServiceWorker, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = 19997
const SERVER_URL = `http://127.0.0.1:${TEST_PORT}`

const jsonHeaders = { 'Content-Type': 'application/json' }

describe('action recording', () => {
  let testCtx: TestContext | null = null
  let recordingsDir: string | null = null

  beforeAll(async () => {
    // Isolate recordings in a temp dir so tests never pollute the user's real
    // ~/.playwriter/recordings (and never collide with a running relay's ids).
    // The relay runs in-process, so the env var is read by getRecordingsDir().
    recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-recordings-test-'))
    process.env.PLAYWRITER_RECORDINGS_DIR = recordingsDir
    testCtx = await setupTestContext({ port: TEST_PORT, tempDirPrefix: 'pw-record-test-', toggleExtension: true })
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx, null)
    testCtx = null
    delete process.env.PLAYWRITER_RECORDINGS_DIR
    if (recordingsDir) {
      fs.rmSync(recordingsDir, { recursive: true, force: true })
    }
  })

  it('records user actions with locator strings and state changes', async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await new Promise((r) => setTimeout(r, 200))

    // create an executor session on the relay
    const sessionResponse = await fetch(`${SERVER_URL}/cli/session/new`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const session = (await sessionResponse.json()) as { id: string }
    expect(session.id).toBeTruthy()

    // start recording
    const startResponse = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    const start = (await startResponse.json()) as { recordingId: string; file: string; error?: string }
    expect(start.error).toBeUndefined()
    expect(start.recordingId).toBeTruthy()

    // starting again on the same session must fail with 409 Conflict
    const duplicateResponse = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    expect(duplicateResponse.status).toBe(409)

    // inject a form and interact via trusted CDP input like a real user
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes('example.com'))
    expect(cdpPage).toBeDefined()
    await cdpPage!.evaluate(() => {
      document.body.innerHTML = `
        <button id="submit-btn" onclick="localStorage.setItem('submitted', 'yes'); this.textContent = 'Done!'">Submit order</button>
        <input id="email" placeholder="Email address" type="text" />
        <input id="attachment" aria-label="Attachment" type="file" />
      `
    })

    const cdp = await getCDPSessionForPage({ page: cdpPage! })
    const clickAt = async (selector: string) => {
      const box = await cdpPage!.locator(selector).boundingBox()
      expect(box).toBeTruthy()
      const x = box!.x + box!.width / 2
      const y = box!.y + box!.height / 2
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }

    await clickAt('#submit-btn')
    await clickAt('#email')
    await cdp.send('Input.insertText', { text: 'hi@example.com' })

    // trigger the extra recorded signals: console error, in-page fetch (its
    // textual response body must be captured), and a file upload
    await cdpPage!.evaluate(async () => {
      console.error('recorder-test-error')
      await fetch('/').then((r) => r.text())
    })
    const tmpFile = path.join(os.tmpdir(), 'recorder-test-attachment.txt')
    fs.writeFileSync(tmpFile, 'hello')
    await cdpPage!.locator('#attachment').setInputFiles(tmpFile)
    // another trusted action so the post-action capture picks up the upload diff
    await clickAt('#submit-btn')

    // wait for action coalescing (800ms) + post-action captures to settle
    await new Promise((r) => setTimeout(r, 3000))

    // status shows the active recording
    const statusResponse = await fetch(`${SERVER_URL}/recorder/status`)
    const status = (await statusResponse.json()) as { recordings: Array<{ recordingId: string; sessionId: string }> }
    expect(status.recordings).toHaveLength(1)
    expect(status.recordings[0].sessionId).toBe(session.id)

    // stop recording
    const stopResponse = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const stop = (await stopResponse.json()) as { recordingId: string; eventCount: number; filePath: string }
    expect(stop.recordingId).toBe(start.recordingId)
    expect(stop.eventCount).toBeGreaterThan(3)

    const events = parseRecording(fs.readFileSync(stop.filePath, 'utf-8'))

    // recorded actions carry generated locator code
    const actionCodes = events.filter((e) => e.type === 'action').map((e) => e.code)
    expect(actionCodes).toMatchInlineSnapshot(`
      [
        "await page1.getByRole('button', { name: 'Submit order' }).click();",
        "await page1.getByRole('textbox', { name: 'Email address' }).click();",
        "await page1.getByRole('textbox', { name: 'Email address' }).fill('hi@example.com');",
        "await page1.getByRole('button', { name: 'Attachment' }).fill('C:\\\\fakepath\\\\recorder-test-attachment.txt');",
        "await page1.getByRole('button', { name: 'Done!' }).click();",
      ]
    `)

    const types = new Set(events.map((e) => e.type))
    expect(types.has('recording-started')).toBe(true)
    expect(types.has('recording-stopped')).toBe(true)
    // clicking the button mutated the DOM (button text) → snapshot diff
    expect(types.has('snapshot-diff')).toBe(true)
    // clicking the button wrote to localStorage → storage event
    const storageEvents = events.filter((e) => e.type === 'storage' && e.kind === 'localStorage')
    expect(storageEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(storageEvents[0].added)).toContain('submitted')
    // clicking into the input changed focus
    expect(types.has('focus')).toBe(true)
    // console.error was recorded
    const consoleEvents = events.filter((e) => e.type === 'console')
    expect(JSON.stringify(consoleEvents)).toContain('recorder-test-error')
    // in-page fetch captured with its textual response body
    const fetchEvents = events.filter((e) => e.type === 'network' && e.resourceType === 'fetch')
    expect(fetchEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(fetchEvents)).toContain('Example Domain')
    // file chosen in input[type=file] was detected
    const uploadEvents = events.filter((e) => e.type === 'file-upload')
    expect(JSON.stringify(uploadEvents)).toContain('recorder-test-attachment.txt')
    // every event has a sequential id for the drill-down view
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1))
    // thin projection replaces heavy payloads with sizes
    const thinFetch = projectThinEvent(fetchEvents[0])
    expect(thinFetch.responseBody).toBeUndefined()
    expect(typeof thinFetch.responseBodySize).toBe('number')
    const thinDiff = projectThinEvent(events.find((e) => e.type === 'snapshot-diff')!)
    expect(thinDiff.content).toBeUndefined()
    expect(typeof thinDiff.contentSize).toBe('number')
    expect(typeof thinDiff.preview).toBe('string')

    // stopping again → 404, no active recording
    const stopAgainResponse = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    expect(stopAgainResponse.status).toBe(404)

    // events are also served over HTTP for remote relays
    const eventsResponse = await fetch(`${SERVER_URL}/recorder/events/${start.recordingId}`)
    expect(eventsResponse.status).toBe(200)
    const remoteEvents = parseRecording(await eventsResponse.text())
    expect(remoteEvents.length).toBe(stop.eventCount)

    // ── second recording on the same session must record actions again ──
    // (regression test for the fork fix: re-enabling the recorder used to
    // leave the cached server recorder in mode 'none')
    const start2Response = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    const start2 = (await start2Response.json()) as { recordingId: string }
    expect(start2.recordingId).not.toBe(start.recordingId)

    await clickAt('#submit-btn')
    await new Promise((r) => setTimeout(r, 2000))

    const stop2Response = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const stop2 = (await stop2Response.json()) as { filePath: string }
    const events2 = parseRecording(fs.readFileSync(stop2.filePath, 'utf-8'))
    const actions2 = events2.filter((e) => e.type === 'action')
    // exactly one action: duplicate listeners in the fork would produce doubles
    expect(actions2.map((e) => e.code)).toMatchInlineSnapshot(`
      [
        "await page1.getByRole('button', { name: 'Done!' }).click();",
      ]
    `)

    await browser.close()
  }, 120000)
})
