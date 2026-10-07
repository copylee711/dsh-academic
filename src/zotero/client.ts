/**
 * Zotero's local API (`http://127.0.0.1:23119/api`, Settings > Advanced >
 * "Allow other applications on this computer to communicate with Zotero").
 * Reads need no key. Writes exist from Zotero 10 on and need the server id
 * this client remembers plus a key from ./auth.ts.
 */
import { readBounded, type FetchLike } from '../net/http.js'

export type ZoteroErrorCode =
  | 'NOT_RUNNING' | 'API_DISABLED' | 'SERVER_CHANGED' | 'NOT_FOUND' | 'UNAUTHORIZED'
  | 'DENIED' | 'READ_ONLY' | 'CONFLICT' | 'BAD_REQUEST' | 'HTTP'

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
}

export class ZoteroError extends Error {
  constructor(readonly code: ZoteroErrorCode, detail?: string, readonly status?: number) {
    super(detail ? `${HINTS[code]} (${detail})` : HINTS[code])
  }
}

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

const MAX_BYTES = 32 * 1_048_576

export class ZoteroClient {
  /** The instance that answered last; a write must name it. */
  serverId: string | undefined
  /** Zotero's own version, e.g. `10.0.5`. */
  version: string | undefined

  constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly onServerChange: () => void = () => {},
  ) {}

  /** One request under `/api/`. Throws ZoteroError for anything but 2xx. */
  async request(path: string, options: ZoteroRequest = {}): Promise<ZoteroResponse> {
    const url = new URL(`/api/${path.replace(/^\/+/, '')}`, this.baseUrl())
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue
      if (typeof value === 'string' || typeof value === 'number') url.searchParams.append(key, String(value))
      else for (const item of value) url.searchParams.append(key, item)
    }
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
      throw new ZoteroError('NOT_RUNNING', timeout.aborted ? 'no answer in time' : undefined)
    }
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

  async json<T = unknown>(path: string, query?: ZoteroRequest['query'], signal?: AbortSignal): Promise<Page<T>> {
    const response = await this.request(path, { ...(query === undefined ? {} : { query }), signal })
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

  /** Whether Zotero answers, and whether it is new enough to be written to. */
  async probe(signal?: AbortSignal): Promise<Probe> {
    try {
      await this.request('', { signal, timeoutMs: 4_000 })
      // Only Zotero 10 and later name themselves; the same versions take writes.
      return { running: true, writable: this.serverId !== undefined, ...(this.serverId === undefined ? {} : { serverId: this.serverId }), ...(this.version === undefined ? {} : { version: this.version }) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { running: !(error instanceof ZoteroError && error.code === 'NOT_RUNNING'), writable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
