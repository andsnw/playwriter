// Unit tests for ActionRecordingManager start timeout, zombie cleanup, and max duration.
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext } from '@xmorse/playwright-core'
import { ActionRecordingManager, isTelemetryUrl, parseRecording } from './action-recorder.js'

function createFakeContext(options: {
  enable?: () => Promise<void>
  disable?: () => Promise<void>
}): BrowserContext {
  return {
    _enableRecorder: options.enable ?? (async () => {}),
    _disableRecorder: options.disable ?? (async () => {}),
    pages: () => [],
    on: () => {},
    off: () => {},
  } as unknown as BrowserContext
}

async function withTempRecordings(fn: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-rec-unit-'))
  const previous = process.env.PLAYWRITER_RECORDINGS_DIR
  process.env.PLAYWRITER_RECORDINGS_DIR = dir
  try {
    await fn(dir)
  } finally {
    if (previous === undefined) {
      delete process.env.PLAYWRITER_RECORDINGS_DIR
    } else {
      process.env.PLAYWRITER_RECORDINGS_DIR = previous
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('isTelemetryUrl', () => {
  test('drops analytics collectors and keeps site APIs', () => {
    expect(isTelemetryUrl('https://www.google-analytics.com/j/collect?v=1')).toBe(true)
    expect(isTelemetryUrl('https://region1.google-analytics.com/g/collect?v=2')).toBe(true)
    expect(isTelemetryUrl('https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query')).toBe(false)
    expect(isTelemetryUrl('https://news.ycombinator.com/x')).toBe(false)
    expect(isTelemetryUrl('https://api.twitter.com/2/tweets')).toBe(false)
    expect(isTelemetryUrl('https://example.com/api?next=https://analytics.example')).toBe(false)
  })
})

describe('ActionRecordingManager start lifecycle', () => {
  test('start times out a hung _enableRecorder and leaves no active recording', async () => {
    await withTempRecordings(async () => {
      const manager = new ActionRecordingManager({
        logger: { log: () => {}, error: () => {} },
      })
      const start = manager.start({
        context: createFakeContext({
          enable: () => {
            return new Promise(() => {})
          },
        }),
        sessionId: '1',
        enableTimeoutMs: 40,
      })
      await expect(start).rejects.toThrow(/failed to start within 40ms/i)
      expect(manager.list()).toEqual([])
    })
  })

  test('stop during a hung start removes the recording so a new start can run', async () => {
    await withTempRecordings(async () => {
      const manager = new ActionRecordingManager({
        logger: { log: () => {}, error: () => {} },
      })
      const start = manager.start({
        context: createFakeContext({
          enable: () => {
            return new Promise(() => {})
          },
        }),
        sessionId: '1',
        enableTimeoutMs: 200,
      })
      await wait(10)
      expect(manager.list()).toHaveLength(1)
      const stopped = await manager.stop({})
      expect(stopped.recordingId).toBeTruthy()
      await expect(start).rejects.toThrow(/stopped before it finished starting/i)
      expect(manager.list()).toEqual([])

      const recorder = await manager.start({
        context: createFakeContext({}),
        sessionId: '1',
        enableTimeoutMs: 40,
      })
      expect(recorder.recordingId).not.toBe(stopped.recordingId)
      await manager.stop({})
    })
  })

  test('recording auto-stops after maxDurationMs', async () => {
    await withTempRecordings(async (dir) => {
      const active: boolean[] = []
      const manager = new ActionRecordingManager({
        logger: { log: () => {}, error: () => {} },
        onActiveChanged: (value) => {
          active.push(value)
        },
      })
      const recorder = await manager.start({
        context: createFakeContext({}),
        sessionId: '1',
        maxDurationMs: 40,
      })
      expect(manager.list()).toHaveLength(1)
      await wait(120)
      expect(manager.list()).toEqual([])
      expect(active).toEqual([true, false])
      const events = parseRecording(fs.readFileSync(path.join(dir, `${recorder.recordingId}.json`), 'utf-8'))
      const stopped = events.filter((event) => {
        return event.type === 'recording-stopped'
      })
      expect(stopped).toHaveLength(1)
      expect(stopped[0].reason).toBe('max-duration')
    })
  })

  test('start still fails when disable also hangs', async () => {
    await withTempRecordings(async () => {
      const manager = new ActionRecordingManager({
        logger: { log: () => {}, error: () => {} },
      })
      const start = manager.start({
        context: createFakeContext({
          enable: () => {
            return new Promise(() => {})
          },
          disable: () => {
            return new Promise(() => {})
          },
        }),
        sessionId: '1',
        enableTimeoutMs: 40,
        disableTimeoutMs: 40,
      })
      await expect(start).rejects.toThrow(/failed to start within 40ms/i)
      expect(manager.list()).toEqual([])
    })
  })

  test('stop after enable but before start finishes does not report success', async () => {
    await withTempRecordings(async () => {
      let release: (() => void) | undefined
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      const manager = new ActionRecordingManager({
        logger: { log: () => {}, error: () => {} },
      })
      const start = manager.start({
        context: createFakeContext({}),
        sessionId: '1',
        holdAfterEnable: () => {
          return hold
        },
      })
      await wait(10)
      expect(manager.list()).toHaveLength(1)
      await manager.stop({})
      release?.()
      await expect(start).rejects.toThrow(/stopped before it finished starting/i)
      expect(manager.list()).toEqual([])
    })
  })
})
