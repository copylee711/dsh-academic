/**
 * Outbound HTTP for the scholarly services: one place for timeouts, bounded
 * bodies, per-host pacing and 429 / 503 retries. Requests go through the
 * global `fetch`, so a proxy installed process-wide (dsh-proxy) applies.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly retryAfterSeconds?: number) {
    super(status === 429 ? `Rate limited by ${new URL(url).host}${retryAfterSeconds === undefined ? '' : ` (retry after ${String(retryAfterSeconds)} s)`}` : `HTTP ${String(status)} from ${new URL(url).host}`)
  }
}

/** Least time between two requests to one host, where the service asks for it. */
const INTERVALS: Record<string, number> = {
  'export.arxiv.org': 3_000,
  'api.crossref.org': 200,
  'doi.org': 200,
  'api.semanticscholar.org': 1_000,
  'eutils.ncbi.nlm.nih.gov': 350,
  'dblp.org': 1_000,
  'arxiv.org': 1_000,
}

export interface RequestOptions {
  headers?: Record<string, string>
  signal?: AbortSignal | undefined
  timeoutMs?: number
  maxBytes?: number
  /** Retries after 429 / 503 (default 2). */
  retries?: number
}

export interface Http {
  text(url: string, options?: RequestOptions): Promise<string>
  json<T = unknown>(url: string, options?: RequestOptions): Promise<T>
  bytes(url: string, options?: RequestOptions): Promise<Uint8Array>
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason as Error); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason as Error) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Read a body, giving up once it passes `maxBytes`. */
export async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`Response larger than ${String(Math.round(maxBytes / 1_048_576))} MB`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}

export function createHttp(fetchImpl: FetchLike = (input, init) => fetch(input, init), delay: typeof abortableDelay = abortableDelay): Http {
  const tails = new Map<string, Promise<void>>()
  const last = new Map<string, number>()

  // One request at a time per paced host, spaced by its interval.
  const pace = async (host: string, signal?: AbortSignal): Promise<void> => {
    const interval = INTERVALS[host]
    if (interval === undefined) return
    const previous = tails.get(host) ?? Promise.resolve()
    let release!: () => void
    tails.set(host, previous.then(() => new Promise<void>(resolve => { release = resolve })))
    await previous
    try {
      const wait = (last.get(host) ?? 0) + interval - Date.now()
      if (wait > 0) await delay(wait, signal)
    } finally {
      last.set(host, Date.now())
      release()
    }
  }

  const bytes = async (url: string, options: RequestOptions = {}): Promise<Uint8Array> => {
    const host = new URL(url).host
    const retries = options.retries ?? 2
    for (let attempt = 0; ; attempt++) {
      await pace(host, options.signal)
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000)
      const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
      const response = await fetchImpl(url, { headers: { 'user-agent': 'dsh-academic (https://github.com/copylee711/dsh-academic)', ...options.headers }, signal, redirect: 'follow' })
      if (response.ok) return await readBounded(response, options.maxBytes ?? 16 * 1_048_576)
      await response.body?.cancel().catch(() => {})
      const header = Number(response.headers.get('retry-after'))
      const retryAfter = Number.isFinite(header) && header > 0 ? header : undefined
      if ((response.status === 429 || response.status === 503) && attempt < retries && (retryAfter ?? 0) <= 20) {
        await delay(Math.max((retryAfter ?? 0) * 1_000, 1_000 * 2 ** attempt), options.signal)
        continue
      }
      throw new HttpError(response.status, url, retryAfter)
    }
  }

  const text = async (url: string, options?: RequestOptions): Promise<string> => new TextDecoder().decode(await bytes(url, options))
  return {
    bytes,
    text,
    json: async <T>(url: string, options?: RequestOptions) => JSON.parse(await text(url, options)) as T,
  }
}
