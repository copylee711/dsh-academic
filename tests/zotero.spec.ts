import { describe, expect, it } from 'vitest'
import { createHttp } from '../src/net/http.js'
import { ZoteroWriter, type KeyStore } from '../src/zotero/auth.js'
import { ZoteroError } from '../src/zotero/client.js'
import { bestAttachment, createReadTools } from '../src/zotero/tools.js'
import { createWriteTools } from '../src/zotero/write-tools.js'
import { fakeZotero, item, run, SERVER_ID, settings, type Reply, type Seen } from './helpers.js'

const paper = item('PAPER001', { title: 'Attention Is All You Need', DOI: '10.5555/attention', collections: ['COLL0001'] }, { meta: { creatorSummary: 'Vaswani et al.', parsedDate: '2017-06-12' }, links: { attachment: { attachmentType: 'application/pdf' } } })
const pdf = item('ATTACH01', { itemType: 'attachment', title: 'Full Text PDF', parentItem: 'PAPER001', linkMode: 'imported_url', contentType: 'application/pdf', filename: 'a.pdf' })
const link = item('ATTACH02', { itemType: 'attachment', title: 'Publisher page', parentItem: 'PAPER001', linkMode: 'linked_url', contentType: 'text/html', url: 'https://example.org/p' })
const note = item('NOTE0001', { itemType: 'note', parentItem: 'PAPER001', note: '<p>Key idea: <b>self-attention</b></p>' })
const highlight = item('ANNOT001', { itemType: 'annotation', parentItem: 'ATTACH01', annotationType: 'highlight', annotationText: 'We propose the Transformer', annotationComment: 'core claim', annotationPageLabel: '2', tags: [{ tag: 'claim' }] })
const collections = [{ key: 'COLL0001', meta: { numItems: 1 }, data: { key: 'COLL0001', name: 'ML', parentCollection: false as const } }, { key: 'COLL0002', meta: { numItems: 0 }, data: { key: 'COLL0002', name: 'NLP', parentCollection: 'COLL0001' } }]

/** The library above, as Zotero's read endpoints answer for it. */
function library(seen: Seen): Reply | undefined {
  if (seen.method !== 'GET') return undefined
  const at = seen.path.replace(/^users\/0\//, '')
  if (seen.path === '') return { body: 'Nothing to see here.' }
  if (at === 'collections') return { body: collections }
  if (at === 'items/top' || at === 'collections/COLL0001/items/top') return { body: [paper], headers: { 'Total-Results': '7' } }
  if (at === 'items') {
    if (seen.query.get('format') === 'bibtex') return { body: '@article{vaswani_attention_2017,\n\ttitle = {Attention}\n}\n' }
    if (seen.query.get('include') === 'bib') return { body: [{ ...paper, bib: '<div class="csl-entry">Vaswani, A. (2017). <i>Attention</i>.</div>' }] }
    if (seen.query.has('tag')) return { body: [highlight] }
    if (seen.query.get('qmode') === 'everything') return { body: seen.query.get('q') === '10.9999/new' ? [] : [pdf, note, paper] }
    return { body: [] }
  }
  if (at === 'items/PAPER001') return { body: paper }
  if (at === 'items/ATTACH01') return { body: pdf }
  if (at === 'items/NOTE0001') return { body: note }
  if (at === 'items/PAPER001/children') return { body: [pdf, link, note] }
  if (at === 'items/ATTACH01/children') return { body: seen.query.get('itemType') === 'annotation' ? [highlight] : [] }
  if (at === 'items/ATTACH01/fulltext') return { body: { content: 'First page about attention.\fSecond page: dropout of 0.1 was applied.\f', indexedPages: 2, totalPages: 2 } }
  return undefined
}

describe('the client', () => {
  it('says what is wrong in words a user can act on', async () => {
    const down = fakeZotero(() => { throw new TypeError('fetch failed') })
    await expect(down.client.json('users/0/items')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    expect(await down.client.probe()).toMatchObject({ running: false, writable: false })
    const off = fakeZotero(() => ({ status: 403, body: 'Local API is not enabled' }))
    await expect(off.client.json('users/0/items')).rejects.toMatchObject({ code: 'API_DISABLED' })
    expect(await off.client.probe()).toMatchObject({ running: true, writable: false })
    const moved = fakeZotero(() => ({ status: 412, body: 'Zotero-Server-ID does not match this server' }))
    await expect(moved.client.request('users/0/items', { method: 'POST', body: [] })).rejects.toMatchObject({ code: 'SERVER_CHANGED' })
    const stale = fakeZotero(() => ({ status: 412, body: 'Library has been modified since specified version' }))
    await expect(stale.client.request('users/0/items', { method: 'POST', body: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('learns the server id and version, and names the server on writes only', async () => {
    const { client, seen } = fakeZotero(library)
    expect(await client.probe()).toEqual({ running: true, writable: true, serverId: SERVER_ID, version: '10.0.5' })
    await client.json('users/0/collections')
    await client.request('users/0/items', { method: 'POST', body: [] }).catch(() => {})
    expect(seen[1]!.headers['Zotero-Server-ID']).toBeUndefined()
    expect(seen[2]!.headers['Zotero-Server-ID']).toBe(SERVER_ID)
    expect(seen.every(request => request.headers['Zotero-API-Version'] === '3')).toBe(true)
  })
  it('treats a Zotero without a server id (before 10) as read-only', async () => {
    const old = fakeZotero(library, null)
    expect(await old.client.probe()).toMatchObject({ running: true, writable: false })
  })
})

describe('reading', () => {
  const setup = (overrides = {}) => {
    const zotero = fakeZotero(library)
    return { ...zotero, tools: createReadTools({ client: zotero.client, settings: settings(overrides), pdfText: async () => '[page 1]\nFrom the PDF file.' }) }
  }

  it('searches top-level items, pages, and fences what the library says', async () => {
    const { tools, seen } = setup()
    const text = await run(tools, 'zotero_search', { query: 'attention', limit: 1, start: 2, collection: 'ml' })
    expect(seen.at(-1)!.path).toBe('users/0/collections/COLL0001/items/top')
    expect(Object.fromEntries(seen.at(-1)!.query)).toMatchObject({ q: 'attention', qmode: 'titleCreatorYear', limit: '1', start: '2', sort: 'dateAdded' })
    expect(text).toContain('7 items for "attention" in collection "ML"; showing 3–3. Next page: start=3.')
    expect(text).toContain('[3] Attention Is All You Need\n    Vaswani et al. · 2017 · journalArticle\n    zotero://user/0/item/PAPER001 · DOI 10.5555/attention · has pdf')
    expect(text).toMatch(/<untrusted-external-content>[\s\S]*<\/untrusted-external-content>$/)
  })
  it('answers a hit inside a PDF, a note or a tagged highlight with the paper', async () => {
    const { tools } = setup()
    const everything = await run(tools, 'zotero_search', { query: 'dropout', mode: 'everything' })
    expect(everything).toContain('1 item for "dropout"')
    expect(everything).toContain('zotero://user/0/item/PAPER001')
    expect(everything).not.toContain('ATTACH01')
    const tagged = await run(tools, 'zotero_search', { tags: ['claim'] })
    expect(tagged).toContain('[1] Attention Is All You Need')
    expect(tagged).not.toContain('ANNOT001')
  })
  it('never returns more than the settings allow', async () => {
    const { tools, seen } = setup({ maxResults: 5 })
    await run(tools, 'zotero_search', { limit: 500 })
    expect(seen.at(-1)!.query.get('limit')).toBe('5')
  })
  it('shows an item with its notes, files and the user\'s highlights', async () => {
    const { tools } = setup()
    const text = await run(tools, 'zotero_get', { ref: 'zotero://user/0/item/PAPER001' })
    expect(text).toContain('collections: ML')
    expect(text).toContain('- Full Text PDF [pdf] zotero://user/0/item/ATTACH01')
    expect(text).toContain('- Publisher page [snapshot, web link]')
    expect(text).toContain('note zotero://user/0/item/NOTE0001:\nKey idea: self-attention')
    expect(text).toContain('- (highlight, p. 2) "We propose the Transformer" — note: core claim')
    expect(await run(tools, 'zotero_get', { ref: 'PAPER001', include: [] })).not.toContain('highlight')
    await expect(run(tools, 'zotero_get', { ref: 'MISSING1' })).rejects.toThrow('No item zotero://user/0/item/MISSING1')
  })
  it('reads the text in chunks with page markers', async () => {
    const { tools, seen } = setup()
    const first = await run(tools, 'zotero_read', { ref: 'PAPER001', max_chars: 500 })
    expect(first).toContain('"Attention Is All You Need"')
    expect(first).toContain('read from Zotero\'s index')
    expect(first).toContain('[page 1]\nFirst page about attention.\n\n[page 2]\nSecond page: dropout of 0.1 was applied.')
    expect(first).toContain('is_truncated: false')
    const fetched = seen.filter(request => request.path.endsWith('/fulltext')).length
    const next = await run(tools, 'zotero_read', { ref: 'ATTACH01', start: 20, max_chars: 500 })
    expect(next).toContain('Characters 20–')
    expect(seen.filter(request => request.path.endsWith('/fulltext')).length).toBe(fetched)
  })
  it('finds the passage that answers a question', async () => {
    const { tools } = setup()
    const text = await run(tools, 'zotero_read', { ref: 'PAPER001', query: 'dropout' })
    expect(text).toContain('Best passages for "dropout"')
    expect(text).toContain('dropout of 0.1')
    expect(await run(tools, 'zotero_read', { ref: 'PAPER001', query: 'photosynthesis' })).toContain('No passage matches')
  })
  it('exports what Zotero formats, grouped per library', async () => {
    const { tools, seen } = setup({ citationStyle: 'ieee' })
    expect(await run(tools, 'zotero_export', { refs: ['PAPER001'], format: 'bibtex' })).toContain('@article{vaswani_attention_2017,')
    expect(Object.fromEntries(seen.at(-1)!.query)).toEqual({ itemKey: 'PAPER001', format: 'bibtex' })
    const bib = await run(tools, 'zotero_export', { refs: ['PAPER001'], format: 'bibliography' })
    expect(bib).toContain('(bibliography, style ieee):\nVaswani, A. (2017). Attention.')
    expect(seen.at(-1)!.query.get('style')).toBe('ieee')
  })
  it('lists collections as paths', async () => {
    const { tools } = setup()
    const text = await run(tools, 'zotero_browse', { kind: 'collections' })
    expect(text).toContain('ML (1 items) zotero://user/0/collection/COLL0001\nML / NLP (0 items) zotero://user/0/collection/COLL0002')
    expect(await run(tools, 'zotero_browse', { kind: 'collections', query: 'vision' })).toBe('No collections containing "vision".')
  })
  it('prefers a stored PDF over a web link', () => {
    expect(bestAttachment([link, note, pdf])?.key).toBe('ATTACH01')
    expect(bestAttachment([link, note])).toBeUndefined()
  })
})

describe('writing', () => {
  const memoryStore = (initial?: { serverId: string; key: string }) => {
    let value = initial
    const store: KeyStore = { load: async () => value, save: async next => { value = next } }
    return { store, get: () => value }
  }
  /** A Zotero that hands out keys (`remember` = Always Allow) and accepts writes carrying a live one. */
  const setup = (options: { remember?: boolean; deny?: boolean; stored?: { serverId: string; key: string }; refuse?: (body: unknown) => Reply | undefined } = {}) => {
    const live = new Set<string>(options.stored && options.stored.key !== 'REVOKED' ? [options.stored.key] : [])
    let issued = 0
    let created = 0
    const zotero = fakeZotero(seen => {
      if (seen.method === 'GET') return library(seen)
      if (seen.path === 'local/authorize') {
        if (options.deny) return { status: 403, body: { denied: true } }
        const key = `KEY${String(++issued)}`
        live.add(key)
        return { body: { key, remember: options.remember === true } }
      }
      const key = seen.headers['Zotero-API-Key'] ?? ''
      if (!live.has(key)) return { status: 401, body: 'Invalid or expired API key' }
      if (options.remember !== true && !options.stored) live.delete(key)
      const refused = options.refuse?.(seen.body)
      if (refused !== undefined) return refused
      const successful = Object.fromEntries((seen.body as Array<{ key?: string }>).map((entry, index) => [String(index), { key: entry.key ?? `NEW0000${String(++created)}` }]))
      return { body: { successful, unchanged: {}, failed: {} } }
    })
    const keys = memoryStore(options.stored)
    const writer = new ZoteroWriter(zotero.client, keys.store)
    const web = createHttp(async url => {
      if (url.startsWith('https://doi.org/10.9999/new')) return new Response(JSON.stringify({ type: 'journal-article', title: 'A New Paper', author: [{ given: 'Grace', family: 'Hopper' }], issued: { 'date-parts': [[2024]] }, 'container-title': 'Journal of Tests' }))
      return new Response('', { status: 404 })
    }, async () => {})
    const tools = createWriteTools({ client: zotero.client, settings: settings(), writer, http: web })
    const writes = () => zotero.seen.filter(request => request.method !== 'GET' && request.path !== 'local/authorize')
    const asked = () => zotero.seen.filter(request => request.path === 'local/authorize').length
    return { ...zotero, tools, writer, keys, writes, asked }
  }

  it('asks Zotero for a key, and again for each write when the user chose Allow once', async () => {
    const { tools, writes, asked, keys, seen } = setup()
    await run(tools, 'zotero_note', { markdown: 'first', parent: 'PAPER001' })
    await run(tools, 'zotero_note', { markdown: 'second', parent: 'PAPER001' })
    expect(asked()).toBe(2)
    expect(writes().map(write => write.headers['Zotero-API-Key'])).toEqual(['KEY1', 'KEY2'])
    expect(writes().every(write => write.headers['Zotero-Server-ID'] === SERVER_ID)).toBe(true)
    expect(seen.find(request => request.path === 'local/authorize')!.body).toEqual({ appName: 'DeepSeek Harness (dsh-academic)' })
    expect(keys.get()).toBeUndefined()
  })
  it('keeps an Always Allow key, bound to the instance that issued it', async () => {
    const { tools, asked, keys } = setup({ remember: true })
    await run(tools, 'zotero_note', { markdown: 'first' })
    await run(tools, 'zotero_note', { markdown: 'second' })
    expect(asked()).toBe(1)
    expect(keys.get()).toEqual({ serverId: SERVER_ID, key: 'KEY1' })
    const other = setup({ stored: { serverId: 'ANOTHERSERVER', key: 'OLD' }, remember: true })
    await run(other.tools, 'zotero_note', { markdown: 'x' })
    expect(other.writes()[0]!.headers['Zotero-API-Key']).toBe('KEY1')
  })
  it('uses a stored key without asking, and asks once when Zotero revoked it', async () => {
    const kept = setup({ stored: { serverId: SERVER_ID, key: 'STORED' } })
    await run(kept.tools, 'zotero_note', { markdown: 'x' })
    expect(kept.asked()).toBe(0)
    const revoked = setup({ stored: { serverId: SERVER_ID, key: 'REVOKED' }, remember: true })
    await run(revoked.tools, 'zotero_note', { markdown: 'x' })
    expect(revoked.asked()).toBe(1)
    expect(revoked.writes().map(write => write.headers['Zotero-API-Key'])).toEqual(['REVOKED', 'KEY1'])
    expect(revoked.keys.get()).toEqual({ serverId: SERVER_ID, key: 'KEY1' })
  })
  it('stops when the user says no in Zotero, or Zotero is too old to write to', async () => {
    const denied = setup({ deny: true })
    await expect(run(denied.tools, 'zotero_note', { markdown: 'x' })).rejects.toMatchObject({ code: 'DENIED' })
    expect(denied.writes()).toHaveLength(0)
    const old = fakeZotero(library, null)
    const tools = createWriteTools({ client: old.client, settings: settings(), writer: new ZoteroWriter(old.client, memoryStore().store), http: createHttp(async () => new Response('')) })
    await expect(run(tools, 'zotero_note', { markdown: 'x' })).rejects.toBeInstanceOf(ZoteroError)
    await expect(run(tools, 'zotero_note', { markdown: 'x' })).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(old.seen.some(request => request.method !== 'GET')).toBe(false)
  })

  it('adds a work from its DOI metadata and skips what is already there', async () => {
    const { tools, writes } = setup({ remember: true })
    const text = await run(tools, 'zotero_add', { identifiers: ['https://doi.org/10.9999/new', '10.5555/attention', 'some title', '10.9999/unknown'], collection: 'ML / NLP', tags: ['to-read'] })
    expect(text).toContain('Collection: ML / NLP')
    expect(text).toContain('https://doi.org/10.9999/new: added "A New Paper" (journalArticle) zotero://user/0/item/NEW00001')
    expect(text).toContain('10.5555/attention: already in the library as "Attention Is All You Need" zotero://user/0/item/PAPER001')
    expect(text).toContain('some title: not a DOI or an arXiv id; skipped.')
    expect(text).toMatch(/10\.9999\/unknown: could not fetch its metadata \(HTTP 404 from doi\.org\)\. Not added\./)
    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.body).toEqual([{ itemType: 'journalArticle', title: 'A New Paper', creators: [{ creatorType: 'author', firstName: 'Grace', lastName: 'Hopper' }], date: '2024', url: 'https://doi.org/10.9999/new', publicationTitle: 'Journal of Tests', DOI: '10.9999/new', tags: [{ tag: 'to-read' }], collections: ['COLL0002'] }])
  })
  it('falls back to basic fields when Zotero refuses the full record', async () => {
    const { tools, writes } = setup({ remember: true, refuse: body => (body as Array<{ itemType: string }>)[0]!.itemType === 'journalArticle' ? { body: { successful: {}, unchanged: {}, failed: { 0: { code: 400, message: '\'publicationTitle\' is not a valid field' } } } } : undefined })
    const text = await run(tools, 'zotero_add', { identifiers: ['10.9999/new'] })
    expect(text).toContain('added "A New Paper" with basic fields only zotero://user/0/item/NEW00001')
    expect((writes()[1]!.body as Array<Record<string, unknown>>)[0]).toMatchObject({ itemType: 'document', title: 'A New Paper', extra: 'DOI: 10.9999/new' })
  })
  it('creates a note under an item and appends to an existing one', async () => {
    const { tools, writes } = setup({ remember: true })
    expect(await run(tools, 'zotero_note', { markdown: '# Reading notes\n\n- point', parent: 'PAPER001', tags: ['summary'] })).toBe('Note created zotero://user/0/item/NEW00001 under zotero://user/0/item/PAPER001.')
    expect(writes()[0]!.body).toEqual([{ itemType: 'note', note: '<h1>Reading notes</h1>\n<ul><li>point</li></ul>', parentItem: 'PAPER001', tags: [{ tag: 'summary' }] }])
    expect(await run(tools, 'zotero_note', { markdown: 'more', note: 'NOTE0001' })).toBe('Appended to the note zotero://user/0/item/NOTE0001.')
    expect(writes()[1]!.body).toEqual([{ key: 'NOTE0001', version: 3, note: '<p>Key idea: <b>self-attention</b></p>\n<p>more</p>' }])
    await expect(run(tools, 'zotero_note', { markdown: 'x', note: 'PAPER001' })).rejects.toThrow(/must be the ref of a note/)
    await expect(run(tools, 'zotero_note', { markdown: 'x', parent: 'ATTACH01' })).rejects.toThrow(/regular item/)
  })
  it('tags and files items against the version it read', async () => {
    const { tools, writes } = setup({ remember: true })
    const text = await run(tools, 'zotero_organize', { refs: ['PAPER001'], add_tags: ['transformer'], add_collections: ['NLP'], remove_collections: ['ML'], create_collection: 'Survey', create_in: 'ML' })
    expect(writes()[0]!.path).toBe('users/0/collections')
    expect(writes()[0]!.body).toEqual([{ name: 'Survey', parentCollection: 'COLL0001' }])
    expect(writes()[1]!.body).toEqual([{ key: 'PAPER001', version: 3, tags: [{ tag: 'transformer' }], collections: ['COLL0002', 'NEW00001'] }])
    expect(text).toContain('Created collection "ML / Survey" zotero://user/0/collection/NEW00001')
    expect(text).toContain('Updated 1 of 1 item.')
    await expect(run(tools, 'zotero_organize', { refs: ['PAPER001'] })).rejects.toThrow(/Nothing to change/)
    await expect(run(tools, 'zotero_organize', { refs: ['PAPER001'], add_collections: ['Nowhere'] })).rejects.toThrow(/No collection "Nowhere"/)
  })
})
