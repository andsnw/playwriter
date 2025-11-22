import { createMCPClient } from './mcp-client.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, BrowserContext } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { getCdpUrl } from './utils.js'

import { spawn } from 'node:child_process'


const execAsync = promisify(exec)

async function getExtensionServiceWorker(context: BrowserContext) {
    let serviceWorker = context.serviceWorkers().find(sw => sw.url().startsWith('chrome-extension://'))
    if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker', {
            predicate: (sw) => sw.url().startsWith('chrome-extension://')
        })
    }

    return serviceWorker
}

function js(strings: TemplateStringsArray, ...values: any[]): string {
    return strings.reduce(
        (result, str, i) => result + str + (values[i] || ''),
        '',
    )
}

async function killProcessOnPort(port: number): Promise<void> {
    try {
        const { stdout } = await execAsync(`lsof -ti:${port}`)
        const pid = stdout.trim()
        if (pid) {
            await execAsync(`kill -9 ${pid}`)
            console.log(`Killed process ${pid} on port ${port}`)
            await new Promise((resolve) => setTimeout(resolve, 500))
        }
    } catch (error) {
        // No process running on port or already killed
    }
}

declare global {
    var toggleExtensionForActiveTab: () => Promise<{ isConnected: boolean; state: any }>;
    var getExtensionState: () => { connectedTabs: Map<number, { targetId: string }> };
    var chrome: any;
}

describe('MCP Server Tests', () => {
    let client: Awaited<ReturnType<typeof createMCPClient>>['client']
    let cleanup: (() => Promise<void>) | null = null
    let browserContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null
    let userDataDir: string
    let relayServerProcess: any

    beforeAll(async () => {
        await killProcessOnPort(19988)

        // Build extension
        console.log('Building extension...')
        await execAsync('TESTING=1 pnpm build', { cwd: '../extension' })
        console.log('Extension built')

        // Start Relay Server manually
        relayServerProcess = spawn('pnpm', ['tsx', 'src/start-relay-server.ts'], {
            cwd: process.cwd(),
            stdio: 'inherit'
        })

        // Wait for port 19988 to be ready
        await new Promise<void>((resolve, reject) => {
             let retries = 0
             const interval = setInterval(async () => {
                 try {
                     const { stdout } = await execAsync('lsof -ti:19988')
                     if (stdout.trim()) {
                         clearInterval(interval)
                         resolve()
                     }
                 } catch {
                     // ignore
                 }
                 retries++
                 if (retries > 30) {
                     clearInterval(interval)
                     reject(new Error('Relay server failed to start'))
                 }
             }, 1000)
        })

        const result = await createMCPClient()
        client = result.client
        cleanup = result.cleanup

        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-'))
        const extensionPath = path.resolve('../extension/dist')

        browserContext = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
            ],
        })

        // Wait for service worker and connect
        let serviceWorker = browserContext.serviceWorkers()[0]
        if (!serviceWorker) {
            serviceWorker = await browserContext.waitForEvent('serviceworker')
        }

        // Create a page to attach to
        const page = await browserContext.newPage()
        await page.goto('about:blank')

        // Connect the tab
        await serviceWorker.evaluate(async () => {
             await globalThis.toggleExtensionForActiveTab()
        })

    }, 600000) // 10 minutes timeout

    afterAll(async () => {
        if (browserContext) {
            await browserContext.close()
        }
        if (relayServerProcess) {
            relayServerProcess.kill()
        }
        await killProcessOnPort(19988)

        if (userDataDir) {
             try {
                fs.rmSync(userDataDir, { recursive: true, force: true })
            } catch (e) {
                console.error('Failed to cleanup user data dir:', e)
            }
        }
        if (cleanup) {
            await cleanup()
            cleanup = null
        }
    })

    it('should execute code and capture console output', async () => {
        await client.callTool({
            name: 'execute',
            arguments: {
                code: js`
          const newPage = await context.newPage();
          state.page = newPage;
          if (!state.pages) state.pages = [];
          state.pages.push(newPage);
        `,
            },
        })

        const result = await client.callTool({
            name: 'execute',
            arguments: {
                code: js`
          await state.page.goto('https://news.ycombinator.com');
          const title = await state.page.title();
          console.log('Page title:', title);
          return { url: state.page.url(), title };
        `,
            },
        })
        expect(result.content).toMatchInlineSnapshot(`
          [
            {
              "text": "Console output:
          [log] Page title: Hacker News

          Return value:
          {
            "url": "https://news.ycombinator.com/",
            "title": "Hacker News"
          }",
              "type": "text",
            },
          ]
        `)
        expect(result.content).toBeDefined()
    }, 30000)

    it('should get accessibility snapshot of hacker news', async () => {
        await client.callTool({
            name: 'execute',
            arguments: {
                code: js`
          const newPage = await context.newPage();
          state.page = newPage;
          if (!state.pages) state.pages = [];
          state.pages.push(newPage);
        `,
            },
        })

        const result = await client.callTool({
            name: 'execute',
            arguments: {
                code: js`
          await state.page.goto('https://news.ycombinator.com/item?id=1', { waitUntil: 'networkidle' });
          const snapshot = await state.page._snapshotForAI();
          return snapshot;
        `,
            },
        })

        const initialData =
            typeof result === 'object' && result.content?.[0]?.text
                ? tryJsonParse(result.content[0].text)
                : result
        await expect(initialData).toMatchFileSnapshot(
            'snapshots/hacker-news-initial-accessibility.md',
        )
        expect(result.content).toBeDefined()
        expect(initialData).toContain('table')
        expect(initialData).toContain('Hacker News')
    }, 30000)

    it('should get accessibility snapshot of shadcn UI', async () => {
        await client.callTool({
            name: 'execute',
            arguments: {
                code: js`
          const newPage = await context.newPage();
          state.page = newPage;
          if (!state.pages) state.pages = [];
          state.pages.push(newPage);
        `,
            },
        })

        const snapshot = await client.callTool({
            name: 'execute',
            arguments: {
                code: js`
          await state.page.goto('https://ui.shadcn.com/', { waitUntil: 'networkidle' });
          const snapshot = await state.page._snapshotForAI();
          return snapshot;
        `,
            },
        })

        const data =
            typeof snapshot === 'object' && snapshot.content?.[0]?.text
                ? tryJsonParse(snapshot.content[0].text)
                : snapshot
        await expect(data).toMatchFileSnapshot('snapshots/shadcn-ui-accessibility.md')
        expect(snapshot.content).toBeDefined()
        expect(data).toContain('shadcn')
    }, 30000)

    it('should close all created pages', async () => {
        const result = await client.callTool({
            name: 'execute',
            arguments: {
                code: js`
          if (state.pages && state.pages.length > 0) {
            for (const page of state.pages) {
              await page.close();
            }
            const closedCount = state.pages.length;
            state.pages = [];
            return { closedCount };
          }
          return { closedCount: 0 };
        `,
            },
        })

    })

    it('should handle new pages and toggling', async () => {
        if (!browserContext) throw new Error('Browser not initialized')

        // Find the correct service worker by URL
        const serviceWorker = await getExtensionServiceWorker(browserContext)

        // 1. Create a new page
        const page = await browserContext.newPage()
        const testUrl = 'https://example.com/'
        await page.goto(testUrl)

        await page.bringToFront()

        // 2. Enable extension on this new tab
        // Since it's a new page, extension is not connected yet
        const result = await serviceWorker.evaluate(async () => {
            return await globalThis.toggleExtensionForActiveTab()
        })
        expect(result.isConnected).toBe(true)

        // 3. Verify we can connect via direct CDP and see the page
        const cdpUrl = getCdpUrl()
        let directBrowser = await chromium.connectOverCDP(cdpUrl)
        let contexts = directBrowser.contexts()
        let pages = contexts[0].pages()

        // Find our page
        let foundPage = pages.find(p => p.url() === testUrl)
        expect(foundPage).toBeDefined()
        expect(foundPage?.url()).toBe(testUrl)



        // 4. Disable extension on this tab
        const resultDisabled = await serviceWorker.evaluate(async () => {
            return await globalThis.toggleExtensionForActiveTab()
        })
        expect(resultDisabled.isConnected).toBe(false)

        // 5. Try to connect/use the page.
        // connecting to relay will succeed, but listing pages should NOT show our page

        // Connect to relay again
        directBrowser = await chromium.connectOverCDP(cdpUrl)
        contexts = directBrowser.contexts()
        pages = contexts[0].pages()

        foundPage = pages.find(p => p.url() === testUrl)
        expect(foundPage).toBeUndefined()



        // 6. Re-enable extension
        const resultEnabled = await serviceWorker.evaluate(async () => {
            return await globalThis.toggleExtensionForActiveTab()
        })
        expect(resultEnabled.isConnected).toBe(true)

        // 7. Verify page is back

        directBrowser = await chromium.connectOverCDP(cdpUrl)
        // Wait a bit for targets to populate
        await new Promise(r => setTimeout(r, 500))

        contexts = directBrowser.contexts()
        // pages() might need a moment if target attached event comes in
        if (contexts[0].pages().length === 0) {
             await new Promise(r => setTimeout(r, 1000))
        }
        pages = contexts[0].pages()

        foundPage = pages.find(p => p.url() === testUrl)
        expect(foundPage).toBeDefined()
        expect(foundPage?.url()).toBe(testUrl)


        await page.close()
    })
    it('should maintain connection across reloads and navigation', async () => {
        if (!browserContext) throw new Error('Browser not initialized')
        const serviceWorker = await getExtensionServiceWorker(browserContext)

        // 1. Setup page
        const page = await browserContext.newPage()
        const initialUrl = 'https://example.com/'
        await page.goto(initialUrl)
        await page.bringToFront()

        // 2. Enable extension
        await serviceWorker.evaluate(async () => {
            await globalThis.toggleExtensionForActiveTab()
        })

        // 3. Connect via CDP
        const cdpUrl = getCdpUrl()
        const directBrowser = await chromium.connectOverCDP(cdpUrl)
        const connectedPage = directBrowser.contexts()[0].pages().find(p => p.url() === initialUrl)
        expect(connectedPage).toBeDefined()

        // 4. Reload
        // We use a loop to check if it's still connected because reload might cause temporary disconnect/reconnect events
        // that Playwright handles natively if the session ID stays valid.
        await connectedPage?.reload()
        await connectedPage?.waitForLoadState('networkidle')
        expect(await connectedPage?.title()).toBe('Example Domain')

        // 5. Navigate to new URL
        const newUrl = 'https://news.ycombinator.com/'
        await connectedPage?.goto(newUrl)
        await connectedPage?.waitForLoadState('networkidle')

        expect(connectedPage?.url()).toBe(newUrl)
        expect(await connectedPage?.title()).toContain('Hacker News')


        await page.close()
    })

    it('should support multiple concurrent tabs', async () => {
        if (!browserContext) throw new Error('Browser not initialized')
        const serviceWorker = await getExtensionServiceWorker(browserContext)
        await new Promise(resolve => setTimeout(resolve, 500))

        // Tab A
        const pageA = await browserContext.newPage()
        await pageA.goto('https://example.com/tab-a')
        await pageA.bringToFront()
        await new Promise(resolve => setTimeout(resolve, 500))
        await serviceWorker.evaluate(async () => {
            await globalThis.toggleExtensionForActiveTab()
        })

        // Tab B
        const pageB = await browserContext.newPage()
        await pageB.goto('https://example.com/tab-b')
        await pageB.bringToFront()
        await new Promise(resolve => setTimeout(resolve, 500))
        await serviceWorker.evaluate(async () => {
            await globalThis.toggleExtensionForActiveTab()
        })

        // Get target IDs for both
        const targetIds = await serviceWorker.evaluate(async () => {
             const state = globalThis.getExtensionState()
             const chrome = globalThis.chrome
             const tabs = await chrome.tabs.query({})
             const tabA = tabs.find((t: any) => t.url?.includes('tab-a'))
             const tabB = tabs.find((t: any) => t.url?.includes('tab-b'))
             return {
                 idA: state.connectedTabs.get(tabA?.id)?.targetId,
                 idB: state.connectedTabs.get(tabB?.id)?.targetId
             }
        })

        expect(targetIds).toMatchInlineSnapshot({
            idA: expect.any(String),
            idB: expect.any(String)
        }, `
          {
            "idA": Any<String>,
            "idB": Any<String>,
          }
        `)
        expect(targetIds.idA).not.toBe(targetIds.idB)

        // Verify independent connections
        const browser = await chromium.connectOverCDP(getCdpUrl())

        const pages = browser.contexts()[0].pages()

        const results = await Promise.all(pages.map(async (p) => ({
            url: p.url(),
            title: await p.title()
        })))

        expect(results).toMatchInlineSnapshot(`
          [
            {
              "title": "",
              "url": "about:blank",
            },
            {
              "title": "Example Domain",
              "url": "https://example.com/tab-a",
            },
            {
              "title": "Example Domain",
              "url": "https://example.com/tab-b",
            },
          ]
        `)

        await pageA.close()
        await pageB.close()
    })

})


function tryJsonParse(str: string) {
    try {
        return JSON.parse(str)
    } catch {
        return str
    }
}
