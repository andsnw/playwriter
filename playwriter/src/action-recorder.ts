// Action recording for the `playwriter recorder` CLI feature.
//
// Playwright's API-mode recorder is the only action source. We persist those
// actions, attach click x/y + a highlighted screenshot, and record mutating
// xhr/fetch. Heavy post-action work (aria snapshots, cookies, storage, focus)
// was removed: it froze the page on every keystroke via CDP.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext, Frame, Page, Request } from '@xmorse/playwright-core'

// Read at call time (not module load) so tests can point recordings at a temp
// dir via PLAYWRITER_RECORDINGS_DIR without polluting ~/.playwriter
export function getRecordingsDir(): string {
  return process.env.PLAYWRITER_RECORDINGS_DIR || path.join(os.homedir(), '.playwriter', 'recordings')
}

export function recordingFilePath(recordingId: string): string {
  if (!/^\d+$/.test(recordingId)) {
    throw new Error(`Invalid recording id: ${recordingId}`)
  }
  const jsonPath = path.join(getRecordingsDir(), `${recordingId}.json`)
  if (fs.existsSync(jsonPath)) {
    return jsonPath
  }
  const jsonlPath = path.join(getRecordingsDir(), `${recordingId}.jsonl`)
  if (fs.existsSync(jsonlPath)) {
    return jsonlPath
  }
  return jsonPath
}

/** Highest recording id present on disk, or null when there are no recordings.
 *  Used to default `recorder events` to the most recent recording. */
export function latestRecordingId(): string | null {
  let max = 0
  try {
    for (const file of fs.readdirSync(getRecordingsDir())) {
      const match = file.match(/^(\d+)\.(json|jsonl)$/)
      if (match) {
        max = Math.max(max, Number(match[1]))
      }
    }
  } catch {}
  return max > 0 ? String(max) : null
}

/** Parse a recording file. New files are a JSON array; old ones are jsonl. */
export function parseRecording(content: string): RecordedEvent[] {
  const trimmed = content.trim()
  if (!trimmed) {
    return []
  }
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      throw new Error('Recording file is not a JSON array')
    }
    return parsed as RecordedEvent[]
  }
  return trimmed.split('\n').filter(Boolean).map((line) => {
    return JSON.parse(line) as RecordedEvent
  })
}

interface RecorderLogger {
  log: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

// Fork-internal client APIs, not present in the generated public types
interface RecorderCapableContext {
  _enableRecorder: (
    params: { language: string; mode: string; recorderMode: string },
    sink: {
      actionAdded?: (page: Page, actionInContext: ActionInContext, code: string) => void
      actionUpdated?: (page: Page, actionInContext: ActionInContext, code: string) => void
      signalAdded?: (page: Page, signalInContext: SignalInContext) => void
    },
  ) => Promise<void>
  _disableRecorder: () => Promise<void>
}

interface ActionInContext {
  action: { name: string; selector?: string; [key: string]: unknown }
  frame?: { pageAlias?: string; framePath?: string[] }
}

interface SignalInContext {
  signal: { name: string; url?: string; [key: string]: unknown }
  frame?: { pageAlias?: string }
}

export interface RecordedEvent {
  /** Seconds since recording start, 1 decimal */
  t: number
  type: string
  [key: string]: unknown
}

/** Error with an HTTP status code hint for the relay routes */
export class RecordingError extends Error {
  statusCode: number
  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

// The file stores FULL event data (generous caps below). Context economy
// happens at read time: `recorder events` prints a thin projection (heavy
// fields replaced by sizes, see projectThinEvent) and specific event ids can
// be passed to read the full details on demand.
const TRACKED_RESOURCE_TYPES = new Set(['xhr', 'fetch'])
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const POLL_INTERVAL_MS = 1500
const PERSIST_DEBOUNCE_MS = 50
const MAX_EVENTS = 10000
const MAX_RESPONSE_BODY_CHARS = 50000
const MAX_POST_DATA_CHARS = 10000
const MAX_CONSOLE_TEXT_CHARS = 2000
const TEXTUAL_CONTENT_TYPE = /json|text|xml|x-www-form-urlencoded|graphql/i

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  return value.slice(0, max) + `… (${value.length - max} more chars)`
}

/** Short stable fingerprint for change detection without storing the value */
// Thin projection of an event for the default `recorder events` timeline view.
// Heavy payloads are replaced by sizes (or key lists) so the whole timeline is
// cheap to read; full details are fetched per event id.
export function projectThinEvent(event: RecordedEvent): RecordedEvent {
  const thin: RecordedEvent = { ...event }
  const replaceWithSize = (field: string, sizeField: string) => {
    const value = thin[field]
    if (typeof value === 'string') {
      delete thin[field]
      thin[sizeField] = value.length
    }
  }
  replaceWithSize('responseBody', 'responseBodySize')
  replaceWithSize('postData', 'postDataSize')
  if (event.type === 'snapshot-diff' && typeof event.content === 'string') {
    delete thin.content
    thin.contentSize = event.content.length
    thin.preview = truncate(event.content.split('\n').slice(0, 5).join('\n'), 300)
  }
  if (event.type === 'storage') {
    for (const field of ['added', 'changed'] as const) {
      const value = event[field]
      if (value && typeof value === 'object') {
        delete thin[field]
        thin[`${field}Keys`] = Object.keys(value)
      }
    }
  }
  if ((event.type === 'console' || event.type === 'page-error') && typeof event.text === 'string') {
    thin.text = truncate(event.text, 200)
  }
  return thin
}

interface PointerPoint {
  x: number
  y: number
  clientX: number
  clientY: number
  scrollX: number
  scrollY: number
}

interface PageHandlers {
  framenavigated: (frame: Frame) => void
  close: () => void
  download: (download: { url: () => string; suggestedFilename: () => string }) => void
  console: (message: { type: () => string; text: () => string }) => void
  pageerror: (error: Error) => void
}

export interface ActionRecorderOptions {
  context: BrowserContext
  sessionId: string
  recordingId: string
  logger: RecorderLogger
}

export class ActionRecorder {
  readonly recordingId: string
  readonly sessionId: string
  readonly filePath: string
  readonly startedAt = Date.now()
  /** Called once when the recording stops (manual stop or context close) */
  onDidStop: (() => void) | null = null

  private context: BrowserContext
  private logger: RecorderLogger
  private state: 'recording' | 'stopping' | 'stopped' = 'recording'

  private events: RecordedEvent[] = []

  // Serialize async captures so event order matches real order
  private captureChain: Promise<void> = Promise.resolve()
  private pendingCaptures = 0
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  private lastFileInputsByPage = new WeakMap<Page, string>()
  private lastScrollByPage = new WeakMap<Page, { x: number; y: number }>()
  private lastPolledUrlByPage = new WeakMap<Page, string>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pageHandlers = new Map<Page, PageHandlers>()
  private onPageHandler: ((page: Page) => void) | null = null
  private onContextCloseHandler: (() => void) | null = null
  private onRequestFinishedHandler: ((request: Request) => void) | null = null
  private onRequestFailedHandler: ((request: Request) => void) | null = null

  constructor(options: ActionRecorderOptions) {
    this.context = options.context
    this.sessionId = options.sessionId
    this.recordingId = options.recordingId
    this.logger = options.logger
    this.filePath = recordingFilePath(options.recordingId)
  }

  get eventCount() {
    return this.events.length
  }

  /** @param at epoch ms when the event was observed (defaults to now) */
  private writeEvent(event: { type: string; [key: string]: unknown }, at?: number): number {
    if (this.state === 'stopped' && event.type !== 'recording-stopped') {
      return 0
    }
    if (this.events.length >= MAX_EVENTS && event.type !== 'recording-stopped') {
      if (this.events[this.events.length - 1]?.type !== 'truncated') {
        this.events.push({
          id: this.events.length + 1,
          t: this.relativeTime(Date.now()),
          type: 'truncated',
          maxEvents: MAX_EVENTS,
        })
        this.persist()
      }
      return 0
    }
    const id = this.events.length + 1
    this.events.push({
      id,
      ...event,
      t: this.relativeTime(at ?? Date.now()),
    })
    this.persist()
    return id
  }

  private persist() {
    if (this.persistTimer) {
      return
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flushPersist()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  private flushPersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    const tmpPath = `${this.filePath}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.events) + '\n', { mode: 0o600 })
      if (process.platform === 'win32' && fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath)
      }
      fs.renameSync(tmpPath, this.filePath)
    } catch (error) {
      this.logger.error('[record] failed to write event:', error)
      try {
        fs.unlinkSync(tmpPath)
      } catch {}
    }
  }

  private relativeTime(at: number): number {
    return Math.round((at - this.startedAt) / 100) / 10
  }

  async start() {
    fs.mkdirSync(getRecordingsDir(), { recursive: true, mode: 0o700 })
    // 'wx' fails with EEXIST instead of truncating: another relay process
    // (e.g. tests on a different port) may have allocated the same id from the
    // shared recordings dir. The manager retries with the next id on EEXIST.
    fs.writeFileSync(this.filePath, '[]\n', { mode: 0o600, flag: 'wx' })

    const recorderContext = this.context as unknown as RecorderCapableContext
    await recorderContext._enableRecorder(
      { language: 'javascript', mode: 'recording', recorderMode: 'api' },
      {
        actionAdded: (page, actionInContext, code) => {
          this.onRecorderAction({ page, actionInContext, code, isUpdate: false })
        },
        actionUpdated: (page, actionInContext, code) => {
          this.onRecorderAction({ page, actionInContext, code, isUpdate: true })
        },
        signalAdded: (page, signalInContext) => {
          if (this.state !== 'recording') {
            return
          }
          this.writeEvent({
            type: 'signal',
            signal: signalInContext.signal.name,
            url: signalInContext.signal.url,
            pageAlias: signalInContext.frame?.pageAlias,
            pageUrl: safePageUrl(page),
          })
        },
      },
    )

    this.onPageHandler = (page: Page) => {
      if (this.state !== 'recording') {
        return
      }
      this.writeEvent({ type: 'page-opened', url: safePageUrl(page) })
      this.attachPageListeners(page)
    }
    this.context.on('page', this.onPageHandler)

    // Auto-stop when the context closes (extension toggled off, session reset,
    // browser gone). Without this the manager would report a dead recording as
    // active forever and the poll timer would leak.
    this.onContextCloseHandler = () => {
      if (this.state !== 'recording') {
        return
      }
      this.writeEvent({ type: 'context-closed' })
      this.stop().catch((error) => {
        this.logger.error('[record] auto-stop on context close failed:', error)
      })
    }
    this.context.on('close', this.onContextCloseHandler)

    this.onRequestFinishedHandler = (request: Request) => {
      this.recordNetworkRequest(request, null)
    }
    this.onRequestFailedHandler = (request: Request) => {
      this.recordNetworkRequest(request, request.failure()?.errorText || 'failed')
    }
    this.context.on('requestfinished', this.onRequestFinishedHandler)
    this.context.on('requestfailed', this.onRequestFailedHandler)

    for (const page of this.context.pages()) {
      this.attachPageListeners(page)
    }

    // Poll all pages for SPA url changes and wheel scrolling that never
    // produce recorder actions. Cheap: one evaluate per page per interval.
    this.pollTimer = setInterval(() => {
      if (this.pendingCaptures > 3) {
        return
      }
      this.enqueueCapture(() => this.pollPages())
    }, POLL_INTERVAL_MS)

    this.writeEvent({
      type: 'recording-started',
      startedAt: new Date(this.startedAt).toISOString(),
      sessionId: this.sessionId,
      recordingId: this.recordingId,
      urls: this.context.pages().map((p) => safePageUrl(p)),
    })
  }

  async stop(): Promise<{ eventCount: number; filePath: string }> {
    if (this.state !== 'recording') {
      return { eventCount: this.eventCount, filePath: this.filePath }
    }
    // 1. Stop accepting new input: sink handlers and listeners check state
    this.state = 'stopping'
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.detachListeners()
    this.flushPersist()
    // 2. Let in-flight captures finish. New captures can't be enqueued anymore.
    await this.captureChain.catch(() => {})
    // 3. Finalize
    this.state = 'stopped'
    this.writeEvent({
      type: 'recording-stopped',
      durationSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    })
    this.flushPersist()
    const recorderContext = this.context as unknown as RecorderCapableContext
    await recorderContext._disableRecorder().catch((error) => {
      this.logger.error('[record] failed to disable recorder:', error)
    })
    this.onDidStop?.()
    this.onDidStop = null
    return { eventCount: this.eventCount, filePath: this.filePath }
  }

  private detachListeners() {
    if (this.onPageHandler) {
      this.context.off('page', this.onPageHandler)
      this.onPageHandler = null
    }
    if (this.onContextCloseHandler) {
      this.context.off('close', this.onContextCloseHandler)
      this.onContextCloseHandler = null
    }
    if (this.onRequestFinishedHandler) {
      this.context.off('requestfinished', this.onRequestFinishedHandler)
      this.onRequestFinishedHandler = null
    }
    if (this.onRequestFailedHandler) {
      this.context.off('requestfailed', this.onRequestFailedHandler)
      this.onRequestFailedHandler = null
    }
    for (const [page, handlers] of this.pageHandlers) {
      page.off('framenavigated', handlers.framenavigated)
      page.off('close', handlers.close)
      page.off('download', handlers.download)
      page.off('console', handlers.console)
      page.off('pageerror', handlers.pageerror)
    }
    this.pageHandlers.clear()
  }

  private attachPageListeners(page: Page) {
    if (this.pageHandlers.has(page)) {
      return
    }
    const handlers: PageHandlers = {
      framenavigated: (frame) => {
        if (this.state !== 'recording' || frame !== page.mainFrame()) {
          return
        }
        this.writeEvent({ type: 'navigation', url: frame.url() })
        this.lastPolledUrlByPage.set(page, frame.url())
      },
      close: () => {
        if (this.state !== 'recording') {
          return
        }
        this.writeEvent({ type: 'page-closed', url: safePageUrl(page) })
        this.pageHandlers.delete(page)
      },
      // Downloads matter for document-harvesting flows (invoices, statements,
      // shipping labels): the skill needs to know which step produced the file
      download: (download) => {
        if (this.state !== 'recording') {
          return
        }
        this.writeEvent({
          type: 'download',
          url: truncate(download.url(), 500),
          suggestedFilename: download.suggestedFilename(),
          pageUrl: safePageUrl(page),
        })
      },
      // Console errors/warnings + page errors make recordings usable as bug
      // reproduction reports
      console: (message) => {
        if (this.state !== 'recording') {
          return
        }
        const level = message.type()
        if (level !== 'error' && level !== 'warning') {
          return
        }
        this.writeEvent({ type: 'console', level, text: truncate(message.text(), MAX_CONSOLE_TEXT_CHARS), pageUrl: safePageUrl(page) })
      },
      pageerror: (error) => {
        if (this.state !== 'recording') {
          return
        }
        this.writeEvent({ type: 'page-error', message: truncate(String(error.message || error), MAX_CONSOLE_TEXT_CHARS), pageUrl: safePageUrl(page) })
      },
    }
    this.pageHandlers.set(page, handlers)
    page.on('framenavigated', handlers.framenavigated)
    page.on('close', handlers.close)
    page.on('download', handlers.download)
    page.on('console', handlers.console)
    page.on('pageerror', handlers.pageerror)
  }

  private onRecorderAction({
    page,
    actionInContext,
    code,
    isUpdate,
  }: {
    page: Page
    actionInContext: ActionInContext
    code: string
    isUpdate: boolean
  }) {
    if (this.state !== 'recording') {
      return
    }
    const codeText = sanitizeLocatorText(code.trim())
    const selector = actionInContext.action.selector
      ? sanitizeLocatorText(actionInContext.action.selector)
      : undefined
    const actionName = actionInContext.action.name
    const clickCount = typeof actionInContext.action.clickCount === 'number' ? actionInContext.action.clickCount : undefined
    const pointer = pointerFromAction(actionInContext.action)
    // actionUpdated = same fill, next keystroke. Edit the last action in place.
    // Do not key by pageUrl: SPA pushState mid-fill would split one fill in two.
    if (isUpdate) {
      const last = this.lastAction()
      if (last && typeof last.id === 'number') {
        last.code = codeText
        last.selector = selector
        last.pageUrl = safePageUrl(page)
        if (clickCount !== undefined) {
          last.clickCount = clickCount
        }
        this.persist()
        return
      }
    }
    const actionId = this.writeEvent({
      type: 'action',
      action: actionName,
      code: codeText,
      selector,
      clickCount,
      ...(actionName === 'click' && pointer ? pointer : {}),
      pageAlias: actionInContext.frame?.pageAlias,
      framePath: actionInContext.frame?.framePath?.length ? actionInContext.frame.framePath : undefined,
      pageUrl: safePageUrl(page),
    })
    if (actionName === 'click') {
      this.enqueueCapture(() => {
        return this.captureClickScreenshot({ page, actionId, selector, pointer })
      })
    }
    this.enqueueCapture(() => {
      return this.captureFileUploads(page, actionId)
    })
  }

  private lastAction(): RecordedEvent | undefined {
    return this.events.findLast((event) => {
      return event.type === 'action'
    })
  }

  private enqueueCapture(task: () => Promise<void>) {
    if (this.state === 'stopped') {
      return
    }
    this.pendingCaptures++
    this.captureChain = this.captureChain.then(async () => {
      try {
        if (this.state === 'stopped') {
          return
        }
        // Timeout so one hung page.evaluate (crashed tab, blocked renderer)
        // can't stall all later captures and block stop() forever
        await Promise.race([
          task(),
          new Promise<void>((_, reject) => {
            setTimeout(() => {
              reject(new Error('capture timed out after 15s'))
            }, 15000).unref?.()
          }),
        ]).catch((error) => {
          this.logger.error('[record] capture failed:', error)
        })
      } finally {
        this.pendingCaptures--
      }
    })
  }

  // File inputs can't be recorded as recorder actions (the OS file chooser is
  // native), so detect chosen files by diffing input[type=file] states after
  // each action. Only file names are visible to page JS, never full paths.
  private async captureFileUploads(page: Page, afterActionId: number) {
    if (page.isClosed()) {
      return
    }
    const inputs = await page
      .evaluate(() => {
        return [...document.querySelectorAll('input[type=file]')].map((el) => {
          // HTMLInputElement is not in this tsconfig's ambient DOM types
          const input = el as unknown as { id: string; name: string; getAttribute(name: string): string | null; files: ArrayLike<{ name: string }> | null }
          return {
            id: input.id || undefined,
            name: input.name || undefined,
            ariaLabel: input.getAttribute('aria-label') || undefined,
            files: Array.from(input.files || []).map((f) => f.name),
          }
        })
      })
      .catch(() => null)
    if (!inputs) {
      return
    }
    const currentJson = JSON.stringify(inputs)
    const previous = this.lastFileInputsByPage.get(page)
    this.lastFileInputsByPage.set(page, currentJson)
    if (previous === currentJson) {
      return
    }
    const withFiles = inputs.filter((input) => input.files.length > 0)
    if (withFiles.length === 0) {
      return
    }
    this.writeEvent({ type: 'file-upload', afterActionId, inputs: withFiles, pageUrl: safePageUrl(page) })
  }

  private async captureClickScreenshot({
    page,
    actionId,
    selector,
    pointer,
  }: {
    page: Page
    actionId: number
    selector: string | undefined
    pointer: PointerPoint | undefined
  }) {
    if (page.isClosed()) {
      return
    }
    const box = selector
      ? await page
          .locator(selector)
          .first()
          .boundingBox()
          .catch(() => {
            return null
          })
      : null
    const rect = box
      ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
      : pointer
        ? { x: pointer.clientX - 12, y: pointer.clientY - 12, width: 24, height: 24 }
        : null
    const dir = path.join(os.tmpdir(), 'playwriter-recorder', this.recordingId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const screenshotPath = path.join(dir, `${actionId}.png`)
    try {
      if (rect) {
        await page
          .evaluate((highlight) => {
            const existing = document.getElementById('__playwriter_click_rect__')
            existing?.remove()
            const el = document.createElement('div')
            el.id = '__playwriter_click_rect__'
            el.style.cssText = [
              'position:fixed',
              `left:${highlight.x}px`,
              `top:${highlight.y}px`,
              `width:${highlight.width}px`,
              `height:${highlight.height}px`,
              'border:3px solid #ff2d55',
              'box-shadow:0 0 0 2px #fff',
              'pointer-events:none',
              'z-index:2147483647',
            ].join(';')
            document.documentElement.appendChild(el)
          }, rect)
          .catch(() => {})
      }
      await Promise.race([
        page.screenshot({ path: screenshotPath, scale: 'css' }),
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error('click screenshot timed out'))
          }, 8000).unref?.()
        }),
      ])
    } catch (error) {
      this.logger.error('[record] click screenshot failed:', error)
    } finally {
      await page.evaluate(() => {
        document.getElementById('__playwriter_click_rect__')?.remove()
      }).catch(() => {})
    }
    if (!fs.existsSync(screenshotPath)) {
      return
    }
    this.writeEvent({
      type: 'screenshot',
      afterActionId: actionId,
      path: screenshotPath,
      x: pointer?.x,
      y: pointer?.y,
      ...(rect || {}),
      pageUrl: safePageUrl(page),
    })
  }

  private recordNetworkRequest(request: Request, failure: string | null) {
    if (this.state !== 'recording') {
      return
    }
    const resourceType = request.resourceType()
    if (!TRACKED_RESOURCE_TYPES.has(resourceType)) {
      return
    }
    if (!MUTATING_METHODS.has(request.method().toUpperCase())) {
      return
    }
    const url = request.url()
    if (url.startsWith('data:') || url.startsWith('chrome-extension:')) {
      return
    }
    // Timestamp is captured now (when the request finished), not when the
    // queued capture task eventually writes the event
    const observedAt = Date.now()
    this.enqueueCapture(async () => {
      const response = failure ? null : await request.response().catch(() => null)
      const postData = request.postData()
      // Capture textual xhr/fetch response bodies (truncated): they let the
      // agent reverse-engineer the site's API into typed clients or skills
      // that call the API directly instead of driving the UI
      const contentType = response?.headers()['content-type']
      const responseBody: string | null = await (async () => {
        if (!response || resourceType === 'document' || !contentType || !TEXTUAL_CONTENT_TYPE.test(contentType)) {
          return null
        }
        const body = await response.text().catch(() => null)
        return body ? truncate(body, MAX_RESPONSE_BODY_CHARS) : null
      })()
      this.writeEvent(
        {
          type: 'network',
          method: request.method(),
          url: truncate(url, 500),
          resourceType,
          status: response?.status(),
          contentType,
          failure: failure || undefined,
          postData: postData ? truncate(postData, MAX_POST_DATA_CHARS) : undefined,
          responseBody: responseBody || undefined,
        },
        observedAt,
      )
    })
  }

  private async pollPages() {
    for (const page of this.context.pages()) {
      if (page.isClosed()) {
        continue
      }
      // Detect SPA url changes (pushState) that don't fire framenavigated
      const url = safePageUrl(page)
      const lastUrl = this.lastPolledUrlByPage.get(page)
      if (lastUrl !== undefined && lastUrl !== url) {
        this.writeEvent({ type: 'url-changed', url, previousUrl: lastUrl })
      }
      this.lastPolledUrlByPage.set(page, url)

      const scroll = await page
        .evaluate(() => {
          return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
        })
        .catch(() => null)
      if (!scroll) {
        continue
      }
      const lastScroll = this.lastScrollByPage.get(page)
      this.lastScrollByPage.set(page, scroll)
      if (lastScroll && (Math.abs(lastScroll.x - scroll.x) > 50 || Math.abs(lastScroll.y - scroll.y) > 50)) {
        this.writeEvent({ type: 'scroll', x: scroll.x, y: scroll.y, pageUrl: url })
      }
    }
  }
}

function safePageUrl(page: Page): string {
  try {
    return page.url()
  } catch {
    return ''
  }
}

function pointerFromAction(action: ActionInContext['action']): PointerPoint | undefined {
  if (typeof action.x !== 'number' || typeof action.y !== 'number') {
    return undefined
  }
  return {
    x: action.x,
    y: action.y,
    clientX: typeof action.clientX === 'number' ? action.clientX : action.x,
    clientY: typeof action.clientY === 'number' ? action.clientY : action.y,
    scrollX: typeof action.scrollX === 'number' ? action.scrollX : 0,
    scrollY: typeof action.scrollY === 'number' ? action.scrollY : 0,
  }
}

// Icon fonts put private-use glyphs in accessible names (` Login`). Strip them
// so recorded locators stay `getByRole('button', { name: 'Login' })`.
function sanitizeLocatorText(text: string): string {
  return text.replace(/[\uE000-\uF8FF]\s*/g, '').replace(/\s+/g, ' ')
}

// ============================================================================
// Manager: tracks active recordings in the relay process. Recording ids are
// incremental numbers persisted as JSON filenames in ~/.playwriter/recordings
// so ids survive relay restarts (files outlive the process).
// ============================================================================

export class ActionRecordingManager {
  private recordings = new Map<string, ActionRecorder>()
  private logger: RecorderLogger

  constructor({ logger }: { logger: RecorderLogger }) {
    this.logger = logger
  }

  private nextRecordingId(): string {
    let max = Number(latestRecordingId() || 0)
    // Also consider active recordings whose file may not be listed yet
    for (const id of this.recordings.keys()) {
      max = Math.max(max, Number(id) || 0)
    }
    return String(max + 1)
  }

  activeRecordingForSession(sessionId: string): ActionRecorder | null {
    return [...this.recordings.values()].find((r) => r.sessionId === sessionId) || null
  }

  async start({ context, sessionId }: { context: BrowserContext; sessionId: string }): Promise<ActionRecorder> {
    const existing = this.activeRecordingForSession(sessionId)
    if (existing) {
      throw new RecordingError(
        `Session ${sessionId} already has an active recording (id ${existing.recordingId}). Stop it first.`,
        409,
      )
    }
    // Retry on EEXIST: another relay process sharing the recordings dir may
    // allocate the same id concurrently; its file makes the next scan skip it
    for (let attempt = 0; attempt < 20; attempt++) {
      const recorder = new ActionRecorder({
        context,
        sessionId,
        recordingId: this.nextRecordingId(),
        logger: this.logger,
      })
      // Reserve the id before the first await so concurrent starts in this
      // process can't pick the same id or bypass the duplicate-session guard
      this.recordings.set(recorder.recordingId, recorder)
      recorder.onDidStop = () => {
        this.recordings.delete(recorder.recordingId)
      }
      try {
        await recorder.start()
        return recorder
      } catch (error) {
        this.recordings.delete(recorder.recordingId)
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          continue
        }
        throw error
      }
    }
    throw new RecordingError('Could not allocate a recording id after 20 attempts', 500)
  }

  async stop({ recordingId }: { recordingId?: string }): Promise<{ recordingId: string; eventCount: number; filePath: string }> {
    const recorder: ActionRecorder | null = (() => {
      if (recordingId) {
        return this.recordings.get(recordingId) || null
      }
      const all = [...this.recordings.values()]
      return all.length === 1 ? all[0] : null
    })()
    if (!recorder) {
      if (!recordingId && this.recordings.size > 1) {
        throw new RecordingError(
          `Multiple active recordings (${[...this.recordings.keys()].join(', ')}). Pass a recording id.`,
          400,
        )
      }
      throw new RecordingError(recordingId ? `Recording ${recordingId} not found` : 'No active recording', 404)
    }
    const result = await recorder.stop()
    return { recordingId: recorder.recordingId, ...result }
  }

  list(): Array<{ recordingId: string; sessionId: string; startedAt: number; eventCount: number; filePath: string }> {
    return [...this.recordings.values()].map((r) => {
      return {
        recordingId: r.recordingId,
        sessionId: r.sessionId,
        startedAt: r.startedAt,
        eventCount: r.eventCount,
        filePath: r.filePath,
      }
    })
  }
}
