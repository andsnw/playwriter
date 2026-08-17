// Action recording for the `playwriter recorder` CLI feature.
//
// Records user interactions (clicks, fills, presses, navigations) plus derived
// state changes (aria snapshot diffs, network requests, cookie/storage changes,
// focus and scroll) into a jsonl file that an agent later reads to author a
// SKILL.md + utils script automating the same flow.
//
// The locator strings come from the playwright fork's headless recorder:
// context._enableRecorder({ mode: 'recording', recorderMode: 'api' }) emits
// actionAdded/actionUpdated events with generated code like
// `await page.getByRole('button', { name: 'Submit' }).click()`.
//
// Design notes (from oracle review):
// - action events carry an incrementing actionId; async state captures
//   (snapshot/cookies/storage/focus) reference afterActionId so consumers can
//   associate state changes with the action that caused them even when events
//   from a fast action burst interleave.
// - actionAdded vs actionUpdated distinction from playwright is preserved:
//   updates replace the pending action (fill emits one update per keystroke),
//   adds flush the previous pending action first.
// - stop() first stops accepting input (state machine), then flushes, then
//   awaits in-flight captures, so no events are lost or written after stop.
// - recordings auto-stop when the browser context closes (extension toggled
//   off, session reset); the manager is notified via onDidStop.
// - files are chmod 0600 in a 0700 dir. Values (storage, postData) are
//   truncated. This matches the existing local logging posture of
//   ~/.playwriter/cdp.jsonl which already logs all CDP traffic.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext, Frame, Page, Request } from '@xmorse/playwright-core'
import { getAriaSnapshot } from './aria-snapshot.js'
import { getCDPSessionForPage } from './cdp-session.js'
import { createSmartDiff } from './diff-utils.js'

// Read at call time (not module load) so tests can point recordings at a temp
// dir via PLAYWRITER_RECORDINGS_DIR without polluting ~/.playwriter
export function getRecordingsDir(): string {
  return process.env.PLAYWRITER_RECORDINGS_DIR || path.join(os.homedir(), '.playwriter', 'recordings')
}

export function recordingFilePath(recordingId: string): string {
  if (!/^\d+$/.test(recordingId)) {
    throw new Error(`Invalid recording id: ${recordingId}`)
  }
  return path.join(getRecordingsDir(), `${recordingId}.jsonl`)
}

/** Highest recording id present on disk, or null when there are no recordings.
 *  Used to default `recorder events` to the most recent recording. */
export function latestRecordingId(): string | null {
  let max = 0
  try {
    for (const file of fs.readdirSync(getRecordingsDir())) {
      const match = file.match(/^(\d+)\.jsonl$/)
      if (match) {
        max = Math.max(max, Number(match[1]))
      }
    }
  } catch {}
  return max > 0 ? String(max) : null
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

// The jsonl file stores FULL event data (generous caps below). Context
// economy happens at read time: `recorder events` prints a thin projection
// (heavy fields replaced by sizes, see projectThinEvent) and specific event
// ids can be passed to read the full details on demand.
const TRACKED_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch'])
const ACTION_COALESCE_MS = 800
const POLL_INTERVAL_MS = 1500
const MAX_SNAPSHOT_DIFF_CHARS = 50000
const MAX_VALUE_CHARS = 1000
const MAX_EVENTS = 10000
// Response bodies enable use cases like reverse-engineering a typed API client
// from a recorded session. Only textual bodies (json/text/xml/form) of
// xhr/fetch requests are captured.
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
function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)
}

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

interface FocusDescriptor {
  tag: string
  id?: string
  role?: string
  name?: string
  placeholder?: string
  ariaLabel?: string
  text?: string
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

  private actionSeq = 0
  private eventSeq = 0
  private actionCoalesce: Coalescer<PendingRecorderAction>

  // Serialize async captures so jsonl event order matches real order
  private captureChain: Promise<void> = Promise.resolve()
  private pendingCaptures = 0

  private lastSnapshotByPage = new WeakMap<Page, string>()
  private lastCookieState = new Map<string, string>()
  // Per page: `${origin}|${kind}` → key → truncated value. sessionStorage is
  // tab-specific so state must be keyed by page, not just origin.
  private lastStorageByPage = new WeakMap<Page, Map<string, Map<string, string>>>()
  private lastFocusByPage = new WeakMap<Page, string | null>()
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
    this.actionCoalesce = createCoalescer({
      delayMs: ACTION_COALESCE_MS,
      onFlush: (pending) => {
        this.writeEvent(
          {
            type: 'action',
            actionId: pending.actionId,
            action: pending.actionName,
            code: pending.code,
            selector: pending.selector,
            pageAlias: pending.pageAlias,
            framePath: pending.framePath?.length ? pending.framePath : undefined,
            pageUrl: safePageUrl(pending.page),
          },
          pending.observedAt,
        )
        this.enqueueCapture(() => {
          return this.capturePostActionState(pending.page, pending.actionId)
        })
      },
    })
  }

  get eventCount() {
    return this.eventSeq
  }

  /** @param at epoch ms when the event was observed (defaults to now) */
  private writeEvent(event: { type: string; [key: string]: unknown }, at?: number) {
    if (this.state === 'stopped' && event.type !== 'recording-stopped') {
      return
    }
    if (this.eventSeq >= MAX_EVENTS && event.type !== 'recording-stopped') {
      if (this.eventSeq === MAX_EVENTS) {
        this.appendLine({ t: this.relativeTime(Date.now()), type: 'truncated', maxEvents: MAX_EVENTS })
      }
      return
    }
    this.appendLine({ ...event, t: this.relativeTime(at ?? Date.now()) })
  }

  private relativeTime(at: number): number {
    return Math.round((at - this.startedAt) / 100) / 10
  }

  private appendLine(event: RecordedEvent) {
    try {
      // Every event gets a sequential id so `recorder events <rec> <id...>`
      // can drill into full details from the thin timeline view
      const line = { id: ++this.eventSeq, ...event }
      fs.appendFileSync(this.filePath, JSON.stringify(line) + '\n', { mode: 0o600 })
    } catch (error) {
      this.logger.error('[record] failed to write event:', error)
    }
  }

  async start() {
    fs.mkdirSync(getRecordingsDir(), { recursive: true, mode: 0o700 })
    // 'wx' fails with EEXIST instead of truncating: another relay process
    // (e.g. tests on a different port) may have allocated the same id from the
    // shared recordings dir. The manager retries with the next id on EEXIST.
    fs.writeFileSync(this.filePath, '', { mode: 0o600, flag: 'wx' })

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
      // Baseline the new page so its first action can emit meaningful diffs
      this.enqueueCapture(async () => {
        await this.captureStorage(page, { emit: false })
        await this.captureSnapshot(page, { emit: false })
        await this.captureFileUploads(page, -1)
      })
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
      // Backpressure: don't stack polls when captures are already backed up
      if (this.pendingCaptures > 3) {
        return
      }
      this.enqueueCapture(() => this.pollPages())
    }, POLL_INTERVAL_MS)

    // Baseline all pages so the first post-action capture emits meaningful diffs
    this.enqueueCapture(async () => {
      await this.captureCookies({ emit: false })
      for (const page of this.context.pages()) {
        await this.captureStorage(page, { emit: false })
        await this.captureSnapshot(page, { emit: false })
        await this.captureFileUploads(page, -1)
      }
    })

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
    // 2. Flush the pending action and let its capture (and other in-flight
    //    captures) finish. New captures can't be enqueued anymore.
    this.actionCoalesce.flush()
    await this.captureChain.catch(() => {})
    // 3. Finalize
    this.state = 'stopped'
    this.appendLine({
      t: this.relativeTime(Date.now()),
      type: 'recording-stopped',
      durationSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    })
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
    const pending = this.actionCoalesce.pending
    // Playwright already decided merge-vs-new via shouldMergeAction: an update
    // replaces the pending action (same page), an add flushes the previous one.
    const replacesPending = isUpdate && pending !== null && pending.page === page
    if (pending && !replacesPending) {
      this.actionCoalesce.flush()
    }
    const actionName = actionInContext.action.name
    this.actionCoalesce.replace({
      actionId: replacesPending ? pending!.actionId : ++this.actionSeq,
      observedAt: replacesPending ? pending!.observedAt : Date.now(),
      page,
      pageAlias: actionInContext.frame?.pageAlias,
      framePath: actionInContext.frame?.framePath,
      actionName,
      code: sanitizeLocatorText(code.trim()),
      selector: actionInContext.action.selector
        ? sanitizeLocatorText(actionInContext.action.selector)
        : undefined,
    })
    // Only fill needs the 800ms coalesce (one event per keystroke burst).
    // Clicks and navigations must write immediately or their network/navigation
    // events appear first and the timeline reads backwards.
    if (actionName !== 'fill') {
      this.actionCoalesce.flush()
    }
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

  private async capturePostActionState(page: Page, actionId: number) {
    if (page.isClosed()) {
      return
    }
    // Give the page a moment to settle after the action (network, rerenders)
    await new Promise((r) => setTimeout(r, 300))
    await this.captureSnapshot(page, { emit: true, afterActionId: actionId })
    await this.captureFocus(page, actionId)
    await this.captureCookies({ emit: true, afterActionId: actionId })
    await this.captureStorage(page, { emit: true, afterActionId: actionId })
    await this.captureFileUploads(page, actionId)
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
    if (previous === undefined || previous === currentJson) {
      return
    }
    const withFiles = inputs.filter((input) => input.files.length > 0)
    if (withFiles.length === 0) {
      return
    }
    this.writeEvent({ type: 'file-upload', afterActionId, inputs: withFiles, pageUrl: safePageUrl(page) })
  }

  private async captureSnapshot(page: Page, { emit, afterActionId }: { emit: boolean; afterActionId?: number }) {
    if (page.isClosed()) {
      return
    }
    const { snapshot } = await getAriaSnapshot({ page, interactiveOnly: true })
    const previous = this.lastSnapshotByPage.get(page)
    this.lastSnapshotByPage.set(page, snapshot)
    if (!emit || previous === undefined) {
      return
    }
    const diff = createSmartDiff({ oldContent: previous, newContent: snapshot, label: 'snapshot' })
    if (diff.type === 'no-change') {
      return
    }
    this.writeEvent({
      type: 'snapshot-diff',
      afterActionId,
      format: diff.type,
      pageUrl: safePageUrl(page),
      content: truncate(diff.content, MAX_SNAPSHOT_DIFF_CHARS),
    })
  }

  private async captureFocus(page: Page, afterActionId: number) {
    if (page.isClosed()) {
      return
    }
    const descriptor = await page
      .evaluate((): FocusDescriptor | null => {
        const el = document.activeElement
        if (!el || el === document.body) {
          return null
        }
        const text = (el.textContent || '').trim().slice(0, 40)
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          role: el.getAttribute('role') || undefined,
          name: el.getAttribute('name') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          text: text || undefined,
        }
      })
      .catch(() => null)
    const focusJson = descriptor ? JSON.stringify(descriptor) : null
    if (focusJson === this.lastFocusByPage.get(page)) {
      return
    }
    this.lastFocusByPage.set(page, focusJson)
    this.writeEvent({ type: 'focus', afterActionId, element: descriptor, pageUrl: safePageUrl(page) })
  }

  private async captureCookies({ emit, afterActionId }: { emit: boolean; afterActionId?: number }) {
    const cookies = await listCookies({ context: this.context, pages: this.context.pages() })
    const current = new Map<string, string>()
    for (const cookie of cookies) {
      // Value fingerprint (hash, not the value itself) so token rotation shows
      // up as "changed" without dumping secrets into the events file
      current.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, fingerprint(cookie.value))
    }
    const previous = this.lastCookieState
    this.lastCookieState = current
    if (!emit) {
      return
    }
    const added: string[] = []
    const changed: string[] = []
    const removed: string[] = []
    for (const [key, value] of current) {
      const prev = previous.get(key)
      if (prev === undefined) {
        added.push(key)
      } else if (prev !== value) {
        changed.push(key)
      }
    }
    for (const key of previous.keys()) {
      if (!current.has(key)) {
        removed.push(key)
      }
    }
    if (added.length === 0 && changed.length === 0 && removed.length === 0) {
      return
    }
    this.writeEvent({ type: 'cookies', afterActionId, added, changed, removed })
  }

  private async captureStorage(page: Page, { emit, afterActionId }: { emit: boolean; afterActionId?: number }) {
    if (page.isClosed()) {
      return
    }
    const state = await page
      .evaluate(() => {
        const dump = (storage: Storage) => {
          const entries: Record<string, string> = {}
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i)
            if (key !== null) {
              entries[key] = String(storage.getItem(key) ?? '')
            }
          }
          return entries
        }
        return { origin: window.location.origin, localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) }
      })
      .catch(() => null)
    if (!state) {
      return
    }
    let pageStorage = this.lastStorageByPage.get(page)
    if (!pageStorage) {
      pageStorage = new Map()
      this.lastStorageByPage.set(page, pageStorage)
    }
    for (const kind of ['localStorage', 'sessionStorage'] as const) {
      const stateKey = `${state.origin}|${kind}`
      const current = new Map<string, string>(
        Object.entries(state[kind]).map(([key, value]) => [key, truncate(value, MAX_VALUE_CHARS)]),
      )
      const previous = pageStorage.get(stateKey)
      pageStorage.set(stateKey, current)
      if (!emit || !previous) {
        continue
      }
      const added: Record<string, string> = {}
      const changed: Record<string, string> = {}
      const removed: string[] = []
      for (const [key, value] of current) {
        const prev = previous.get(key)
        if (prev === undefined) {
          added[key] = value
        } else if (prev !== value) {
          changed[key] = value
        }
      }
      for (const key of previous.keys()) {
        if (!current.has(key)) {
          removed.push(key)
        }
      }
      if (Object.keys(added).length === 0 && Object.keys(changed).length === 0 && removed.length === 0) {
        continue
      }
      this.writeEvent({ type: 'storage', afterActionId, kind, origin: state.origin, added, changed, removed })
    }
  }

  private recordNetworkRequest(request: Request, failure: string | null) {
    if (this.state !== 'recording') {
      return
    }
    const resourceType = request.resourceType()
    if (!TRACKED_RESOURCE_TYPES.has(resourceType)) {
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

type PendingRecorderAction = {
  actionId: number
  observedAt: number
  page: Page
  pageAlias?: string
  framePath?: string[]
  actionName: string
  code: string
  selector?: string
}

type CookieIdentity = { name: string; domain: string; path: string; value: string }

// Extension mode rejects context.cookies() (Storage.getCookies has no browser
// session). Fall back to Network.getCookies on each page's existing CDP session.
async function listCookies({ context, pages }: { context: BrowserContext; pages: Page[] }): Promise<CookieIdentity[]> {
  try {
    return await context.cookies()
  } catch {}
  const byKey = new Map<string, CookieIdentity>()
  for (const page of pages) {
    if (page.isClosed()) {
      continue
    }
    const session = await getCDPSessionForPage({ page }).catch(() => {
      return null
    })
    if (!session) {
      continue
    }
    const result = await session.send('Network.getCookies').catch(() => {
      return null
    })
    for (const cookie of result?.cookies || []) {
      byKey.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie)
    }
  }
  return [...byKey.values()]
}

// Icon fonts put private-use glyphs in accessible names (` Login`). Strip them
// so recorded locators stay `getByRole('button', { name: 'Login' })`.
function sanitizeLocatorText(text: string): string {
  return text.replace(/[\uE000-\uF8FF]\s*/g, '').replace(/\s+/g, ' ')
}

type Coalescer<T> = {
  readonly pending: T | null
  replace: (value: T) => void
  flush: () => void
}

// Known tradeoff: an actionUpdated after this flush (pause >800ms mid-fill)
// becomes a second action event. Treat consecutive fills on the same selector as one step.
function createCoalescer<T>({ delayMs, onFlush }: { delayMs: number; onFlush: (value: T) => void }): Coalescer<T> {
  let pending: T | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  return {
    get pending() {
      return pending
    },
    replace(value: T) {
      pending = value
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        const valueToFlush = pending
        pending = null
        if (valueToFlush) {
          onFlush(valueToFlush)
        }
      }, delayMs)
    },
    flush() {
      clearTimer()
      const valueToFlush = pending
      pending = null
      if (valueToFlush) {
        onFlush(valueToFlush)
      }
    },
  }
}

// ============================================================================
// Manager: tracks active recordings in the relay process. Recording ids are
// incremental numbers persisted as jsonl filenames in ~/.playwriter/recordings
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
