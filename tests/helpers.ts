/** A stand-in for Zotero's local server: requests are recorded and answered by a route function. */
import type { FetchLike } from '../src/net/http.js'
import { DEFAULTS, type Settings } from '../src/settings.js'
import { ZoteroClient } from '../src/zotero/client.js'
import type { Item } from '../src/zotero/format.js'

export interface Seen { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown }
export interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }

export const SERVER_ID = 'SERVER000001'

export function fakeZotero(route: (seen: Seen) => Reply | undefined, serverId: string | null = SERVER_ID) {
  const seen: Seen[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input)
    const request: Seen = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/?/, ''),
      query: url.searchParams,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    seen.push(request)
    const reply = route(request) ?? { status: 404, body: 'Not found' }
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? '')
    return new Response(body, { status: reply.status ?? 200, headers: { ...(serverId === null ? {} : { "Zotero-Server-ID": serverId }), 'X-Zotero-Version': '10.0.5', ...reply.headers } })
  }
  const client = new ZoteroClient(() => DEFAULTS.zoteroBaseUrl, fetchImpl)
  return { client, seen, fetchImpl }
}

export const settings = (overrides: Partial<Settings> = {}) => (): Settings => ({ ...DEFAULTS, ...overrides })

export function item(key: string, data: Partial<Item['data']> = {}, extra: Partial<Item> = {}): Item {
  return { key, version: 3, data: { key, version: 3, itemType: 'journalArticle', title: `Title ${key}`, creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }], date: '2020-05-01', ...data }, ...extra }
}

export async function run(tools: ReadonlyArray<{ name: string; execute: unknown }>, name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return (await (tool.execute as (args: unknown, exec: unknown) => Promise<{ text: string }>)(args, { signal: new AbortController().signal })).text
}
