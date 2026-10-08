/**
 * A browser of the plugin's own, driven over the DevTools protocol: an
 * ordinary Chrome or Edge window with its own profile, kept off the screen.
 * It is not a headless browser and nothing about it is disguised; the sites
 * see a normal browser going through the system's proxy settings. When a
 * site asks for a human check, the window is brought on screen for the user
 * to answer (see ./sites.ts): the plugin does not answer such checks.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { abortableDelay } from '../net/http.js'
import { Mutex } from '../storage.js'

/** One page of the browser, as much of it as the site scripts need. */
export interface Tab {
  /** Load a URL and wait until the document is there. */
  goto(url: string, signal?: AbortSignal): Promise<void>
  /** Run an expression in the page and return its value (JSON-serializable). */
  evaluate<T = unknown>(expression: string): Promise<T>
  /** Type into the focused field. */
  type(text: string): Promise<void>
  /** Put the window on screen, in front, for the user. */
  show(): Promise<void>
  /** Take the window off the screen again. */
  hide(): Promise<void>
  close(): Promise<void>
}

export interface WebBrowser {
  /** Run one job with a fresh tab; jobs run one after another. */
  use<T>(job: (tab: Tab) => Promise<T>, signal?: AbortSignal): Promise<T>
  /** Waits used by the site scripts; replaced in tests. */
  pace?: { delay?: typeof abortableDelay; checkWaitMs?: number }
  /** Close the browser if this plugin started it. */
  dispose(): Promise<void>
}

export interface SessionOptions {
  /** Path of the browser program, or why there is none. */
  program(): Promise<string | undefined>
  /** Folder for the browser's own profile (cookies stay here between runs). */
  profileDir: string
  /** Close the browser after this long without a job. */
  idleMs?: number
}

const OFF_SCREEN = -32_000
const SIZE = { width: 1280, height: 900 }

interface Reply { id?: number; result?: unknown; error?: { message?: string } }

class CdpTab implements Tab {
  private next = 0
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()

  private constructor(private readonly socket: WebSocket, private readonly port: string, private readonly id: string) {
    socket.addEventListener('message', event => {
      const reply = JSON.parse(String(event.data)) as Reply
      if (reply.id === undefined) return
      const pending = this.waiting.get(reply.id)
      if (pending === undefined) return
      this.waiting.delete(reply.id)
      if (reply.error !== undefined) pending.reject(new Error(reply.error.message ?? 'browser error'))
      else pending.resolve(reply.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.waiting.values()) pending.reject(new Error('The browser window was closed.'))
      this.waiting.clear()
    })
  }

  static async open(port: string): Promise<CdpTab> {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    if (!response.ok) throw new Error(`The browser refused a new tab (HTTP ${String(response.status)}).`)
    const target = await response.json() as { id: string; webSocketDebuggerUrl: string }
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => { resolve() }, { once: true })
      socket.addEventListener('error', () => { reject(new Error('Could not connect to the browser tab.')) }, { once: true })
    })
    const tab = new CdpTab(socket, port, target.id)
    await tab.send('Page.enable')
    return tab
  }

  private send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error('The browser window was closed.')); return }
      const id = ++this.next
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async goto(url: string, signal?: AbortSignal): Promise<void> {
    await this.send('Page.navigate', { url })
    for (let waited = 0; waited < 30_000; waited += 250) {
      await abortableDelay(250, signal)
      const state = await this.evaluate<string>('document.readyState').catch(() => 'loading')
      if (state === 'complete' || (state === 'interactive' && waited >= 4_000)) return
    }
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const reply = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.exceptionDetails !== undefined) throw new Error(`Page script failed: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'unknown error'}`)
    return reply.result?.value as T
  }

  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  private async bounds(bounds: Record<string, unknown>): Promise<void> {
    const { windowId } = await this.send<{ windowId: number }>('Browser.getWindowForTarget')
    await this.send('Browser.setWindowBounds', { windowId, bounds })
  }

  async show(): Promise<void> {
    await this.bounds({ windowState: 'normal' }).catch(() => {})
    await this.bounds({ left: 80, top: 60, ...SIZE })
    await this.send('Page.bringToFront').catch(() => {})
  }

  async hide(): Promise<void> {
    await this.bounds({ left: OFF_SCREEN, top: OFF_SCREEN, ...SIZE }).catch(() => {})
  }

  async close(): Promise<void> {
    try { this.socket.close() } catch { /* already closed */ }
    await fetch(`http://127.0.0.1:${this.port}/json/close/${this.id}`).then(response => response.body?.cancel(), () => {})
  }
}

/** The port a browser with this profile listens on, if one is running. */
async function livePort(profileDir: string): Promise<string | undefined> {
  const port = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]?.trim() ?? ''
  if (!/^\d+$/.test(port)) return undefined
  const alive = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_500) }).then(response => { void response.body?.cancel(); return response.ok }, () => false)
  return alive ? port : undefined
}

export function createBrowserSession(options: SessionOptions): WebBrowser {
  const queue = new Mutex()
  const idleMs = options.idleMs ?? 600_000
  let child: ChildProcess | undefined
  let port: string | undefined
  let idle: ReturnType<typeof setTimeout> | undefined

  const stop = async (): Promise<void> => {
    if (idle !== undefined) { clearTimeout(idle); idle = undefined }
    const running = child
    child = undefined
    port = undefined
    if (running !== undefined && running.exitCode === null) running.kill()
  }

  const start = async (signal?: AbortSignal): Promise<string> => {
    if (port !== undefined && await livePort(options.profileDir) === port) return port
    // One left running by an earlier session of the host is taken over rather than doubled.
    const existing = await livePort(options.profileDir)
    if (existing !== undefined) { port = existing; return existing }
    const program = await options.program()
    if (program === undefined) throw new Error('No Chrome or Edge was found on this computer to search this site with. The user can install one, or give its path in Settings > 学术.')
    await mkdir(options.profileDir, { recursive: true })
    await rm(join(options.profileDir, 'DevToolsActivePort'), { force: true })
    child = spawn(program, [
      `--user-data-dir=${options.profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      `--window-position=${String(OFF_SCREEN)},${String(OFF_SCREEN)}`, `--window-size=${String(SIZE.width)},${String(SIZE.height)}`, 'about:blank',
    ], { stdio: 'ignore' })
    child.on('error', () => {})
    child.on('exit', () => { child = undefined; port = undefined })
    for (let waited = 0; waited < 20_000; waited += 200) {
      await abortableDelay(200, signal)
      const found = await livePort(options.profileDir)
      if (found !== undefined) { port = found; return found }
    }
    await stop()
    throw new Error('The browser was started but did not open its control port in 20 seconds.')
  }

  return {
    use(job, signal) {
      return queue.run(async () => {
        if (idle !== undefined) { clearTimeout(idle); idle = undefined }
        const tab = await CdpTab.open(await start(signal))
        try {
          return await job(tab)
        } finally {
          await tab.hide()
          await tab.close()
          idle = setTimeout(() => { void stop() }, idleMs)
          idle.unref()
        }
      })
    },
    dispose: stop,
  }
}
