import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/net/http.js'
import { resolveConfig, type ZoteroSource } from '../src/settings.js'
import { ZoteroWriter, type KeyStore } from '../src/zotero/auth.js'
import { CLOUD_URL, ZoteroClient } from '../src/zotero/client.js'
import { createLauncher, findZotero, type Launcher } from '../src/zotero/launch.js'
import { createReadTools } from '../src/zotero/tools.js'
import { item, run, settings } from './helpers.js'

const KEY = 'abcdefghijklmnopqrstuvwx'
const paper = item('PAPER001', { title: 'Attention Is All You Need' })
const pdf = item('ATTACH01', { itemType: 'attachment', title: 'Full Text PDF', parentItem: 'PAPER001', linkMode: 'imported_url', contentType: 'application/pdf', filename: 'a.pdf' })

interface Call { url: URL; method: string; headers: Record<string, string>; body: unknown }

/** This computer's Zotero (up or down) and zotero.org, both answering for one small library. */
function world(options: { source?: ZoteroSource; key?: string; launcher?: Launcher; cloud?(call: Call): Response | undefined } = {}) {
  const state = { localUp: false, time: 1_000_000 }
  const calls: Call[] = []
  const reply = (body: unknown, headers: Record<string, string> = {}, status = 200): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  const fetchImpl: FetchLike = async (input, init) => {
    const call: Call = { url: new URL(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const { url } = call
    if (url.host === '127.0.0.1:23119') {
      if (!state.localUp) throw new TypeError('fetch failed')
      const local = { 'Zotero-Server-ID': 'SERVER000001', 'X-Zotero-Version': '10.0.5' }
      if (url.pathname === '/api/users/0/items/top') return reply([paper], { ...local, 'Total-Results': '1' })
      return reply('ok', local)
    }
    if (url.host === 'api.zotero.org') {
      const custom = options.cloud?.(call)
      if (custom !== undefined) return custom
      if (call.headers['Zotero-API-Key'] !== KEY) return reply('Invalid key', {}, 403)
      if (url.pathname === '/keys/current') return reply({ userID: 42, username: 'ada', access: { user: { library: true, write: true, files: true } } })
      if (url.pathname === '/users/42/items/top') return reply([paper], { 'Total-Results': '1' })
      if (url.pathname === '/users/42/items/PAPER001') return reply(paper)
      if (url.pathname === '/users/42/items/PAPER001/children') return reply([pdf])
      if (url.pathname === '/users/42/items/ATTACH01/file') return new Response(null, { status: 302, headers: { Location: 'https://files.example/signed?x=1' } })
      if (url.pathname === '/users/42/items' && call.method === 'POST') return reply({ successful: { 0: { key: 'NEWITEM1' } }, unchanged: {}, failed: {} })
      return reply('Not found', {}, 404)
    }
    if (url.host === 'files.example') return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    return reply('?', {}, 500)
  }
  const client = new ZoteroClient(() => 'http://127.0.0.1:23119', fetchImpl, undefined, {
    source: () => options.source ?? 'auto',
    cloudKey: () => options.key ?? '',
    ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    delay: async ms => { state.time += ms },
    now: () => state.time,
  })
  const to = (host: string): Call[] => calls.filter(call => call.url.host === host)
  return { client, calls, state, to }
}

const launcherThat = (start: () => string | undefined) => {
  const launcher = { starts: 0, enabled: () => true, start: async () => { launcher.starts++; return start() } }
  return launcher
}

describe('finding and starting Zotero', () => {
  const registry = async (_command: string, args: string[]): Promise<string | undefined> =>
    (args[1]!.includes('App Paths') && args[1]!.startsWith('HKLM') ? '\r\nHKEY_LOCAL_MACHINE\\...\\zotero.exe\r\n    (Default)    REG_SZ    D:\\Program Files\\Zotero\\zotero.exe\r\n' : undefined)

  it('asks the system where Zotero was installed, then the usual places', async () => {
    expect(await findZotero('', { platform: 'win32', env: {}, run: registry, exists: async () => true })).toBe('D:\\Program Files\\Zotero\\zotero.exe')
    expect(await findZotero('', { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, run: async () => undefined, exists: async path => path.startsWith('C:\\Program Files') })).toMatch(/Program Files[\\/]Zotero[\\/]zotero\.exe$/)
    expect(await findZotero('', { platform: 'darwin', run: async () => undefined, exists: async path => path === '/Applications/Zotero.app' })).toBe('/Applications/Zotero.app')
    expect(await findZotero('', { platform: 'linux', run: async () => undefined, exists: async () => false })).toBeUndefined()
    // A path in settings is the only one tried.
    expect(await findZotero('E:\\z\\zotero.exe', { platform: 'win32', run: registry, exists: async path => path.startsWith('D:') })).toBeUndefined()
  })
  it('starts it out of the way, or says why it could not', async () => {
    const started: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const detach = (command: string, args: string[], env?: NodeJS.ProcessEnv): void => { started.push({ command, args, ...(env === undefined ? {} : { env }) }) }
    const windows = createLauncher({ enabled: () => true, path: () => '' }, { platform: 'win32', env: {}, run: registry, exists: async () => true, detach })
    expect(await windows.start()).toBeUndefined()
    expect(started[0]!.command).toBe('powershell.exe')
    // The watcher goes first so it is there when the window shows; Zotero is started on its own, not from the script.
    expect(started[1]).toEqual({ command: 'D:\\Program Files\\Zotero\\zotero.exe', args: [] })
    const script = Buffer.from(started[0]!.args.at(-1)!, 'base64').toString('utf16le')
    // Minimized without taking the focus; never hidden.
    expect(script).toContain('ShowWindowAsync($p.MainWindowHandle, 7)')
    expect(script).not.toContain('Start-Process')
    expect(script).not.toMatch(/ShowWindowAsync\([^)]*, 0\)/)
    const mac = createLauncher({ enabled: () => true, path: () => '' }, { platform: 'darwin', run: async () => undefined, exists: async path => path === '/Applications/Zotero.app', detach })
    expect(await mac.start()).toBeUndefined()
    expect(started[2]).toMatchObject({ command: 'open', args: ['-g', '-j', '/Applications/Zotero.app'] })
    const none = createLauncher({ enabled: () => true, path: () => '' }, { platform: 'linux', run: async () => undefined, exists: async () => false, detach })
    expect(await none.start()).toBe('Zotero was not found on this computer')
    expect(started).toHaveLength(3)
  })
})

describe('a Zotero that is not running', () => {
  it('is started once, and the request goes through when it answers', async () => {
    let scene!: ReturnType<typeof world>
    const launcher = launcherThat(() => { setTimeout(() => {}, 0); scene.state.localUp = true; return undefined })
    scene = world({ launcher })
    const [first, second] = await Promise.all([scene.client.json('users/0/items/top'), scene.client.json('users/0/items/top')])
    expect(first.total).toBe(1)
    expect(second.total).toBe(1)
    expect(launcher.starts).toBe(1)
    expect(scene.client.via).toBe('local')
    expect(scene.to('api.zotero.org')).toHaveLength(0)
  })
  it('says what was tried when it cannot be started and there is no online library', async () => {
    const launcher = launcherThat(() => 'Zotero was not found on this computer')
    const { client } = world({ launcher })
    await expect(client.json('users/0/items/top')).rejects.toMatchObject({ code: 'NOT_RUNNING', message: expect.stringContaining('starting it was tried: Zotero was not found on this computer') })
    // Not started again for every call that follows.
    await expect(client.json('users/0/items/top')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    expect(launcher.starts).toBe(1)
  })
  it('gives up on a start that never answers, then lets zotero.org stand in for a while', async () => {
    const launcher = launcherThat(() => undefined)
    const { client, state, to } = world({ launcher, key: KEY })
    expect((await client.json('users/0/items/top')).total).toBe(1)
    expect(client.via).toBe('cloud')
    expect(client.startError).toMatch(/did not answer in 45 seconds/)
    expect(to('api.zotero.org').map(call => call.url.pathname)).toEqual(['/keys/current', '/users/42/items/top'])
    const localBefore = to('127.0.0.1:23119').length
    await client.json('users/0/items/top')
    // While it stands in, this computer is not asked and the key's owner is not looked up again.
    expect(to('127.0.0.1:23119')).toHaveLength(localBefore)
    expect(to('api.zotero.org')).toHaveLength(3)
    // Later the local Zotero, started by hand meanwhile, is preferred again.
    state.time += 61_000
    state.localUp = true
    await client.json('users/0/items/top')
    expect(client.via).toBe('local')
    expect(launcher.starts).toBe(1)
  })
  it('is left alone when the source is local only, and never asked when it is cloud only', async () => {
    const off = world({ source: 'local', key: KEY })
    await expect(off.client.json('users/0/items/top')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    expect(off.to('api.zotero.org')).toHaveLength(0)
    const online = world({ source: 'cloud', key: KEY })
    online.state.localUp = true
    await online.client.json('users/0/items/top')
    expect(online.to('127.0.0.1:23119')).toHaveLength(0)
    await expect(world({ source: 'cloud' }).client.json('users/0/items/top')).rejects.toMatchObject({ code: 'CLOUD_KEY' })
  })
  it('is not started by a look at its state', async () => {
    const launcher = launcherThat(() => undefined)
    const { client } = world({ launcher, key: KEY })
    expect(await client.probe()).toMatchObject({ running: false })
    await expect(client.json('users/0/items/top', undefined, undefined, 'local')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    expect(launcher.starts).toBe(0)
  })
})

describe('the library on zotero.org', () => {
  it('reports a refused key and waits once when told to slow down', async () => {
    const wrong = world({ source: 'cloud', key: 'zzzzzzzzzzzzzzzzzzzzzzzz' })
    await expect(wrong.client.json('users/0/items/top')).rejects.toMatchObject({ code: 'CLOUD_DENIED' })
    let busy = 2
    const slow = world({ source: 'cloud', key: KEY, cloud: call => (call.url.pathname.endsWith('/items/top') && busy-- > 0 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : undefined) })
    await expect(slow.client.json('users/0/items/top')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect((await slow.client.json('users/0/items/top')).total).toBe(1)
  })
  it('answers the read tools and says the answer is the synced copy', async () => {
    const { client, to } = world({ source: 'cloud', key: KEY })
    const tools = createReadTools({ client, settings: settings(), pdfData: async data => `pdf of ${String(data.length)} bytes` })
    const found = await run(tools, 'zotero_search', { query: 'attention' })
    expect(found).toContain('Answered by zotero.org')
    expect(found).toContain('Attention Is All You Need')
    // No indexed text online: the file itself is fetched, and the key is not sent to the storage host.
    const text = await run(tools, 'zotero_read', { ref: 'PAPER001' })
    expect(text).toContain('read from the PDF in Zotero\'s online storage')
    expect(text).toContain('pdf of 4 bytes')
    expect(to('files.example')[0]!.headers['Zotero-API-Key']).toBeUndefined()
    expect(to('api.zotero.org').every(call => call.headers['Zotero-API-Key'] === KEY)).toBe(true)
    expect(await run(tools, 'zotero_attachment', { ref: 'PAPER001' })).toContain('in the online library')
    await expect(run(tools, 'zotero_search', { saved_search: 'SEARCH01' })).rejects.toThrow(/zotero\.org does not run saved searches/)
  })
  it('is written with the user\'s key, without Zotero\'s dialog', async () => {
    const { client, calls } = world({ source: 'cloud', key: KEY })
    const store: KeyStore = { load: async () => undefined, save: async () => {} }
    const response = await new ZoteroWriter(client, store).write('users/0/items', { method: 'POST', body: [{ itemType: 'note', note: 'x' }] })
    expect(JSON.parse(response.text).successful[0].key).toBe('NEWITEM1')
    const post = calls.find(call => call.method === 'POST')!
    expect(post.url.href).toBe(`${CLOUD_URL}/users/42/items`)
    expect(post.headers['Zotero-API-Key']).toBe(KEY)
    expect(calls.some(call => call.url.pathname.includes('authorize'))).toBe(false)
  })
})

describe('the new settings', () => {
  it('fall back to safe values', () => {
    expect(resolveConfig({})).toMatchObject({ zoteroSource: 'auto', zoteroApiKey: '', zoteroAutoStart: true, zoteroPath: '' })
    expect(resolveConfig({ zoteroSource: 'ftp', zoteroApiKey: 'has spaces', zoteroAutoStart: 'yes', zoteroPath: ' "D:\\Zotero\\zotero.exe" ' })).toMatchObject({ zoteroSource: 'auto', zoteroApiKey: '', zoteroAutoStart: true, zoteroPath: 'D:\\Zotero\\zotero.exe' })
    expect(resolveConfig({ zoteroSource: 'cloud', zoteroApiKey: ` ${KEY} `, zoteroAutoStart: false })).toMatchObject({ zoteroSource: 'cloud', zoteroApiKey: KEY, zoteroAutoStart: false })
  })
})
