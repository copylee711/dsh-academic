/**
 * The user's Zotero library, reached one of two ways with the same paths:
 *
 * - the local API of the Zotero on this computer (`http://127.0.0.1:23119/api`,
 *   Settings > Advanced > "Allow other applications on this computer to
 *   communicate with Zotero"). Reads need no key. Writes exist from Zotero 10
 *   on and need the server id this client remembers plus a key from ./auth.ts.
 * - zotero.org (`https://api.zotero.org`) with the user's API key: what has
 *   been synced, readable and writable without Zotero running.
 *
 * In `auto` the local one is asked first. When it does not answer, Zotero is
 * started if that is switched on; failing that, zotero.org takes over for a
 * while if a key is set.
 */
import { abortableDelay, readBounded, type FetchLike } from '../net/http.js'
import type { ZoteroSource } from '../settings.js'
import type { Launcher } from './launch.js'

export type ZoteroErrorCode =
  | 'NOT_RUNNING' | 'API_DISABLED' | 'SERVER_CHANGED' | 'NOT_FOUND' | 'UNAUTHORIZED'
  | 'DENIED' | 'READ_ONLY' | 'CONFLICT' | 'BAD_REQUEST' | 'HTTP'
  | 'CLOUD_KEY' | 'CLOUD_DENIED' | 'CLOUD_UNREACHABLE' | 'RATE_LIMITED'

const HINTS: Record<ZoteroErrorCode, string> = {
  NOT_RUNNING: 'Zotero is not running on this computer (or its local server is on another port). Ask the user to start Zotero.',
  API_DISABLED: 'Zotero\'s local API is off. The user turns it on in Zotero: Settings > Advanced > "Allow other applications on this computer to communicate with Zotero".',
  SERVER_CHANGED: 'A different Zotero instance answered than before; refs and versions from earlier calls may not apply. Search again.',
  NOT_FOUND: 'Zotero has no such object.',
  UNAUTHORIZED: 'Zotero did not accept the write key.',
  DENIED: 'The user declined the request in Zotero.',
  READ_ONLY: 'This Zotero cannot be written through the local API (needs Zotero 10 or later, and a library the user may edit).',
  CONFLICT: 'The library changed since it was read. Read the item again, then retry.',
  BAD_REQUEST: 'Zotero rejected the request.',
  HTTP: 'Zotero answered with an error.',
  CLOUD_KEY: 'The online Zotero library needs an API key: the user creates one at zotero.org/settings/keys and enters it in Settings > 学术.',
  CLOUD_DENIED: 'zotero.org refused: the API key is wrong or revoked, or does not allow this (library access, write access or this group). The user can change what the key allows at zotero.org/settings/keys.',
  CLOUD_UNREACHABLE: 'zotero.org could not be reached.',
  RATE_LIMITED: 'zotero.org is limiting requests from this key. Wait a little before the next call.',
}

export class ZoteroError extends Error {
  constructor(readonly code: ZoteroErrorCode, detail?: string, readonly status?: number) {
    super(detail ? `${HINTS[code]} (${detail})` : HINTS[code])
  }
}

export type Via = 'local' | 'cloud'

export interface ZoteroResponse {
  status: number
  headers: Headers
  text: string
}

export interface ZoteroRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  query?: Record<string, string | number | readonly string[] | undefined>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal | undefined
  timeoutMs?: number
  /** Ask this side only, without starting Zotero or falling back. */
  via?: Via
}

export interface Page<T> {
  data: T
  /** Rows matching in all, from `Total-Results`. */
  total?: number
  /** Library version, from `Last-Modified-Version`. */
  version?: number
}

export interface Probe {
  running: boolean
  /** Whether this Zotero takes writes on the local API (Zotero 10 or later). */
  writable: boolean
  serverId?: string
  version?: string
  error?: string
}

/** Who a zotero.org key belongs to and what it may do. */
export interface CloudAccount {
  userId: string
  username: string
  /** May read the personal library. */
  library: boolean
  /** May change the personal library. */
  write: boolean
  /** May download attached files. */
  files: boolean
}

export interface ZoteroOptions {
  source?(): ZoteroSource
  /** The zotero.org API key from settings; empty when there is none. */
  cloudKey?(): string
  launcher?: Launcher
  /** Waits; replaced in tests. */
  delay?: typeof abortableDelay
  now?(): number
}

export const CLOUD_URL = 'https://api.zotero.org'

const MAX_BYTES = 32 * 1_048_576
const MAX_FILE_BYTES = 80 * 1_048_576
/** How long to wait for a Zotero that was just started. */
const START_WAIT_MS = 45_000
/** After a start that did not work, do not try again for this long. */
const START_COOLDOWN_MS = 120_000
/** How long zotero.org stands in before the local Zotero is asked again. */
const CLOUD_STAND_IN_MS = 60_000

export class ZoteroClient {
  /** The instance that answered last; a write must name it. */
  serverId: string | undefined
  /** Zotero's own version, e.g. `10.0.5`. */
  version: string | undefined
  /** Which side answered the last request. */
  via: Via = 'local'
  /** Why Zotero could not be started the last time it was tried. */
  startError: string | undefined

  private cloudUntil = 0
  private startBlockedUntil = 0
  private recovering: Promise<Via> | undefined
  private account: { key: string; value: CloudAccount } | undefined
  private readonly source: () => ZoteroSource
  private readonly cloudKey: () => string
  private readonly launcher: Launcher | undefined
  private readonly delay: typeof abortableDelay
  private readonly now: () => number

  constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly onServerChange: () => void = () => {},
    options: ZoteroOptions = {},
  ) {
    this.source = options.source ?? (() => 'local')
    this.cloudKey = options.cloudKey ?? (() => '')
    this.launcher = options.launcher
    this.delay = options.delay ?? abortableDelay
    this.now = options.now ?? (() => Date.now())
  }

  /** One request under `/api/` (or its zotero.org twin). Throws ZoteroError for anything but 2xx. */
  async request(path: string, options: ZoteroRequest = {}): Promise<ZoteroResponse> {
    if (options.via !== undefined) return options.via === 'cloud' ? await this.cloud(path, options) : await this.local(path, options)
    if (this.standingIn()) return await this.cloud(path, options)
    try {
      return await this.local(path, options)
    } catch (error) {
      // A refused connection sent nothing, so the request can go out again. One that timed out may have arrived.
      if (!(error instanceof ZoteroError) || error.code !== 'NOT_RUNNING' || error.status === 408) throw error
      const via = await this.recover(options.signal)
      return via === 'cloud' ? await this.cloud(path, options) : await this.local(path, options)
    }
  }

  /** Which side will answer now, starting Zotero if need be. A write asks this first to pick its key. */
  async ready(signal?: AbortSignal): Promise<Via> {
    if (this.standingIn()) return 'cloud'
    const probe = await this.probe(signal)
    return probe.running ? 'local' : await this.recover(signal)
  }

  private standingIn(): boolean {
    const source = this.source()
    return source === 'cloud' || (source === 'auto' && this.cloudKey() !== '' && this.now() < this.cloudUntil)
  }

  /** The local Zotero did not answer: start it, or let zotero.org stand in. One attempt at a time. */
  private recover(signal?: AbortSignal): Promise<Via> {
    this.recovering ??= this.recoverOnce(signal).finally(() => { this.recovering = undefined })
    return this.recovering
  }

  private async recoverOnce(signal?: AbortSignal): Promise<Via> {
    let tried = ''
    if (this.launcher?.enabled() === true) {
      if (this.now() < this.startBlockedUntil) tried = this.startError ?? ''
      else {
        this.startError = await this.launcher.start()
        if (this.startError === undefined) {
          const deadline = this.now() + START_WAIT_MS
          while (this.now() < deadline) {
            await this.delay(700, signal)
            if ((await this.probe(signal)).running) return 'local'
          }
          this.startError = 'Zotero was started but its local server did not answer in 45 seconds'
        }
        this.startBlockedUntil = this.now() + START_COOLDOWN_MS
        tried = this.startError
      }
    }
    if (this.source() === 'auto' && this.cloudKey() !== '') {
      this.cloudUntil = this.now() + CLOUD_STAND_IN_MS
      return 'cloud'
    }
    throw new ZoteroError('NOT_RUNNING', tried === '' ? undefined : `starting it was tried: ${tried}`)
  }

  private async local(path: string, options: ZoteroRequest): Promise<ZoteroResponse> {
    const url = withQuery(new URL(`/api/${path.replace(/^\/+/, '')}`, this.baseUrl()), options.query)
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { 'Zotero-API-Version': '3', ...options.headers }
    if (method !== 'GET' && this.serverId !== undefined) headers['Zotero-Server-ID'] = this.serverId
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
    let response: Response
    try {
      response = await this.fetchImpl(url.href, {
        method,
        headers,
        redirect: 'manual',
        signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw timeout.aborted ? new ZoteroError('NOT_RUNNING', 'no answer in time', 408) : new ZoteroError('NOT_RUNNING')
    }
    this.via = 'local'
    this.version = response.headers.get('X-Zotero-Version') ?? this.version
    const serverId = response.headers.get('Zotero-Server-ID') ?? undefined
    if (serverId !== undefined && serverId !== this.serverId) {
      const changed = this.serverId !== undefined
      this.serverId = serverId
      if (changed) this.onServerChange()
    }
    const text = new TextDecoder().decode(await readBounded(response, MAX_BYTES))
    if (response.status >= 200 && response.status < 300) return { status: response.status, headers: response.headers, text }
    const detail = text.trim().slice(0, 300) || undefined
    switch (response.status) {
      case 401: throw new ZoteroError('UNAUTHORIZED', detail, 401)
      case 403: throw new ZoteroError(method === 'GET' ? 'API_DISABLED' : /not enabled/i.test(text) ? 'API_DISABLED' : /denied/i.test(text) && path.startsWith('local/authorize') ? 'DENIED' : 'READ_ONLY', detail, 403)
      case 404: throw new ZoteroError('NOT_FOUND', detail, 404)
      case 405: case 501: throw new ZoteroError(method === 'GET' ? 'HTTP' : 'READ_ONLY', detail, response.status)
      case 412: throw new ZoteroError(/Server-ID/i.test(text) ? 'SERVER_CHANGED' : 'CONFLICT', detail, 412)
      case 400: case 409: case 413: case 428: throw new ZoteroError('BAD_REQUEST', detail, response.status)
      default: throw new ZoteroError('HTTP', `HTTP ${String(response.status)}${detail ? `: ${detail}` : ''}`, response.status)
    }
  }

  /** One exchange with zotero.org, waiting once when it asks to slow down. */
  private async cloudFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }, options: Pick<ZoteroRequest, 'signal' | 'timeoutMs'>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
      let response: Response
      try {
        response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]) })
      } catch (error) {
        if (options.signal?.aborted) throw error
        throw new ZoteroError('CLOUD_UNREACHABLE', timeout.aborted ? 'no answer in time' : undefined)
      }
      if (response.status !== 429 && response.status !== 503) return response
      const wait = Number(response.headers.get('Retry-After') ?? '2')
      if (attempt > 0 || !Number.isFinite(wait) || wait > 20) throw new ZoteroError(response.status === 429 ? 'RATE_LIMITED' : 'CLOUD_UNREACHABLE', response.status === 503 ? 'HTTP 503' : undefined, response.status)
      await response.body?.cancel().catch(() => {})
      await this.delay(Math.max(1, wait) * 1_000, options.signal)
    }
  }

  /** Whose key this is. Asked once per key. */
  async cloudAccount(signal?: AbortSignal): Promise<CloudAccount> {
    const key = this.cloudKey()
    if (key === '') throw new ZoteroError('CLOUD_KEY')
    if (this.account?.key === key) return this.account.value
    const response = await this.cloudFetch(`${CLOUD_URL}/keys/current`, { method: 'GET', headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': key } }, { signal, timeoutMs: 15_000 })
    const text = new TextDecoder().decode(await readBounded(response, 1_048_576))
    if (response.status === 403 || response.status === 404) throw new ZoteroError('CLOUD_DENIED', text.trim().slice(0, 200) || undefined, response.status)
    if (response.status !== 200) throw new ZoteroError('HTTP', `HTTP ${String(response.status)} from zotero.org`, response.status)
    const body = JSON.parse(text) as { userID?: number; username?: string; access?: { user?: { library?: boolean; write?: boolean; files?: boolean } } }
    if (body.userID === undefined) throw new ZoteroError('CLOUD_DENIED', 'zotero.org did not say whose key this is')
    const value: CloudAccount = { userId: String(body.userID), username: body.username ?? '', library: body.access?.user?.library === true, write: body.access?.user?.write === true, files: body.access?.user?.files === true }
    this.account = { key, value }
    return value
  }

  /** `users/0/…` on this computer is `users/<id>/…` on zotero.org. */
  private async cloudUrl(path: string, query: ZoteroRequest['query'], signal?: AbortSignal): Promise<string> {
    const account = await this.cloudAccount(signal)
    const clean = path.replace(/^\/+/, '')
    if (clean.startsWith('local/')) throw new ZoteroError('BAD_REQUEST', 'not a zotero.org request')
    return withQuery(new URL(`/${clean.replace(/^users\/0(?=\/|$)/, `users/${account.userId}`)}`, CLOUD_URL), query).href
  }

  private async cloud(path: string, options: ZoteroRequest): Promise<ZoteroResponse> {
    const url = await this.cloudUrl(path, options.query, options.signal)
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { 'Zotero-API-Version': '3', ...options.headers, 'Zotero-API-Key': this.cloudKey() }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await this.cloudFetch(url, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }, options)
    this.via = 'cloud'
    const text = new TextDecoder().decode(await readBounded(response, MAX_BYTES))
    if (response.status >= 200 && response.status < 300) return { status: response.status, headers: response.headers, text }
    const detail = text.trim().slice(0, 300) || undefined
    switch (response.status) {
      case 401: case 403: throw new ZoteroError('CLOUD_DENIED', detail, response.status)
      case 404: throw new ZoteroError('NOT_FOUND', detail, 404)
      case 412: throw new ZoteroError('CONFLICT', detail, 412)
      case 400: case 409: case 413: case 428: throw new ZoteroError('BAD_REQUEST', detail, response.status)
      default: throw new ZoteroError('HTTP', `HTTP ${String(response.status)} from zotero.org${detail ? `: ${detail}` : ''}`, response.status)
    }
  }

  /** The bytes of an attachment kept in Zotero's online storage; undefined when it is not there. */
  async cloudFile(path: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const url = await this.cloudUrl(path, undefined, signal)
    const first = await this.cloudFetch(url, { method: 'GET', headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': this.cloudKey() } }, { signal, timeoutMs: 60_000 })
    let response = first
    if (first.status >= 300 && first.status < 400) {
      const target = first.headers.get('Location')
      await first.body?.cancel().catch(() => {})
      if (!target?.startsWith('https://')) return undefined
      // The storage link is signed; the API key stays with zotero.org.
      const timeout = AbortSignal.timeout(120_000)
      try {
        response = await this.fetchImpl(target, { method: 'GET', signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) })
      } catch (error) {
        if (signal?.aborted) throw error
        throw new ZoteroError('CLOUD_UNREACHABLE', 'the file could not be downloaded')
      }
    }
    if (response.status === 404) return undefined
    if (response.status === 401 || response.status === 403) throw new ZoteroError('CLOUD_DENIED', 'the key does not allow file access', response.status)
    if (response.status !== 200) throw new ZoteroError('HTTP', `HTTP ${String(response.status)} for the file`, response.status)
    return await readBounded(response, MAX_FILE_BYTES)
  }

  async json<T = unknown>(path: string, query?: ZoteroRequest['query'], signal?: AbortSignal, via?: Via): Promise<Page<T>> {
    const response = await this.request(path, { ...(query === undefined ? {} : { query }), signal, ...(via === undefined ? {} : { via }) })
    const total = Number(response.headers.get('Total-Results'))
    const version = Number(response.headers.get('Last-Modified-Version'))
    return {
      data: JSON.parse(response.text) as T,
      ...(response.headers.has('Total-Results') && Number.isFinite(total) ? { total } : {}),
      ...(response.headers.has('Last-Modified-Version') && Number.isFinite(version) ? { version } : {}),
    }
  }

  async text(path: string, query?: ZoteroRequest['query'], signal?: AbortSignal): Promise<string> {
    return (await this.request(path, { ...(query === undefined ? {} : { query }), signal })).text
  }

  /** Whether the Zotero on this computer answers, and whether it is new enough to be written to. Starts nothing. */
  async probe(signal?: AbortSignal): Promise<Probe> {
    try {
      await this.local('', { signal, timeoutMs: 4_000 })
      // Only Zotero 10 and later name themselves; the same versions take writes.
      return { running: true, writable: this.serverId !== undefined, ...(this.serverId === undefined ? {} : { serverId: this.serverId }), ...(this.version === undefined ? {} : { version: this.version }) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { running: !(error instanceof ZoteroError && error.code === 'NOT_RUNNING'), writable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function withQuery(url: URL, query: ZoteroRequest['query']): URL {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number') url.searchParams.append(key, String(value))
    else for (const item of value) url.searchParams.append(key, item)
  }
  return url
}
