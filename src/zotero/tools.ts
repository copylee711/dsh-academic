/**
 * The Zotero tools that only read: search, browse, one item with its notes
 * and annotations, the text of a paper, citation export, attachment location.
 */
import { access, readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool, type ToolCallView } from '@deepseek-ai/dsh-tools'
import { joinPages, pdfFileText, pdfText } from '../fulltext/pdf.js'
import { untrusted } from '../net/untrusted.js'
import type { Settings } from '../settings.js'
import { ZoteroError, type ZoteroClient } from './client.js'
import { clip, collectionPaths, formatAnnotation, formatAttachment, formatHit, formatItem, htmlToText, type Collection, type Item } from './format.js'
import { formatRef, libraryOf, libraryPath, parseRef, type Library, type Ref } from './refs.js'
import { rankPassages } from './retrieve.js'

export type ToolDefinition = ReturnType<typeof defineTool>

export interface ZoteroHost {
  client: ZoteroClient
  settings(): Settings
  /** Text of a local PDF; replaced in tests. */
  pdfText?(path: string): Promise<string>
  /** Text of a PDF held in memory (one downloaded from zotero.org); replaced in tests. */
  pdfData?(data: Uint8Array): Promise<string>
}

/** Said with a result that came from zotero.org, so a missing recent change is no surprise. */
export const cloudNote = (host: ZoteroHost): string => (host.client.via === 'cloud' ? ' Answered by zotero.org (the synced copy of the library; the Zotero on this computer is not running).' : '')

export interface Value { text: string }

export const output = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args: unknown, value: Value) => [{ type: 'text' as const, text: value.text }],
} as const

export const card = (title: string, kind: 'read' | 'edit' | 'search' = 'read'): ToolCallView => ({ card: 'generic', title, kind })

const LIBRARY_PARAM = { type: 'string', description: 'Library to use instead of the one in settings: "user" for the personal library, or a group id from zotero_browse kind=libraries.' } as const

export function libraryFor(host: ZoteroHost, override?: unknown): Library {
  const text = typeof override === 'string' ? override.trim() : ''
  return libraryOf(text === '' ? host.settings().zoteroLibrary : text === 'user' ? '0' : text)
}

export function refOf(host: ZoteroHost, input: unknown): Ref {
  return parseRef(input, libraryFor(host))
}

export async function getItem(host: ZoteroHost, ref: Ref, signal?: AbortSignal): Promise<Item> {
  try {
    return (await host.client.json<Item>(`${libraryPath(ref.library)}/items/${ref.key}`, undefined, signal)).data
  } catch (error) {
    if (error instanceof ZoteroError && error.code === 'NOT_FOUND') throw new Error(`No item ${formatRef(ref.library, ref.key)} in Zotero.`)
    throw error
  }
}

export async function listCollections(host: ZoteroHost, library: Library, signal?: AbortSignal): Promise<Collection[]> {
  return (await host.client.json<Collection[]>(`${libraryPath(library)}/collections`, undefined, signal)).data
}

/** A collection named by ref, key, name or `Parent / Child` path. */
export async function findCollection(host: ZoteroHost, library: Library, input: string, signal?: AbortSignal): Promise<{ key: string; path: string }> {
  const collections = await listCollections(host, library, signal)
  const paths = collectionPaths(collections)
  const wanted = input.trim()
  let key: string | undefined
  try { key = parseRef(wanted, library).key } catch { key = undefined }
  if (key !== undefined && paths.has(key)) return { key, path: paths.get(key)! }
  const lower = wanted.toLowerCase()
  const matches = collections.filter(collection => collection.data.name.toLowerCase() === lower || paths.get(collection.key)?.toLowerCase() === lower)
  if (matches.length === 1) return { key: matches[0]!.key, path: paths.get(matches[0]!.key)! }
  if (matches.length > 1) throw new Error(`${String(matches.length)} collections are named "${wanted}": ${matches.map(match => `${paths.get(match.key)!} (${formatRef(library, match.key, 'collection')})`).join('; ')}. Give the ref.`)
  throw new Error(`No collection "${wanted}". List them with zotero_browse kind=collections.`)
}

const FILE_RANK = ['application/pdf', 'application/epub+zip', 'text/html', 'text/plain']

/** The attachment worth reading: PDFs first, stored files before links. */
export function bestAttachment(children: readonly Item[]): Item | undefined {
  const files = children.filter(child => child.data.itemType === 'attachment' && child.data.linkMode !== 'linked_url')
  const rank = (item: Item): number => { const index = FILE_RANK.indexOf(item.data.contentType ?? ''); return index === -1 ? FILE_RANK.length : index }
  return [...files].sort((a, b) => rank(a) - rank(b) || String(a.data.dateAdded ?? '').localeCompare(String(b.data.dateAdded ?? '')))[0]
}

async function children(host: ZoteroHost, ref: Ref, signal?: AbortSignal, query?: Record<string, string>): Promise<Item[]> {
  return (await host.client.json<Item[]>(`${libraryPath(ref.library)}/items/${ref.key}/children`, query, signal)).data
}

/** Path on disk of a stored attachment, or undefined when Zotero has no file for it. */
async function attachmentPath(host: ZoteroHost, ref: Ref, signal?: AbortSignal): Promise<string | undefined> {
  // zotero.org knows nothing of this computer's disk.
  if (host.client.via === 'cloud') return undefined
  try {
    const url = (await host.client.text(`${libraryPath(ref.library)}/items/${ref.key}/file/view/url`, undefined, signal)).trim()
    return url.startsWith('file:') ? fileURLToPath(url) : undefined
  } catch (error) {
    if (error instanceof ZoteroError && (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST')) return undefined
    throw error
  }
}

interface FullText { text: string; source: string }

export function createReadTools(host: ZoteroHost): ToolDefinition[] {
  const { client } = host
  const tools: ToolDefinition[] = []
  // The text of the papers read last, so paging through one costs one extraction.
  const texts = new Map<string, FullText>()

  const fullText = async (attachment: Item, ref: Ref, signal?: AbortSignal): Promise<FullText> => {
    const cacheKey = `${client.via}:${client.serverId ?? ''}:${libraryPath(ref.library)}:${attachment.key}:${String(attachment.version ?? '')}`
    const cached = texts.get(cacheKey)
    if (cached !== undefined) return cached
    let found: FullText | undefined
    try {
      const indexed = (await client.json<{ content?: string; indexedPages?: number; totalPages?: number }>(`${libraryPath(ref.library)}/items/${attachment.key}/fulltext`, undefined, signal)).data
      if (indexed.content?.trim()) {
        // Zotero's index keeps the form feed that ends each PDF page.
        const pages = indexed.content.split('\f')
        const partial = indexed.indexedPages !== undefined && indexed.totalPages !== undefined && indexed.indexedPages < indexed.totalPages
        found = {
          text: pages.length > 2 ? joinPages(pages.at(-1)?.trim() === '' ? pages.slice(0, -1) : pages) : indexed.content,
          source: `Zotero's index${partial ? ` (only the first ${String(indexed.indexedPages)} of ${String(indexed.totalPages)} pages are indexed)` : ''}`,
        }
      }
    } catch (error) {
      if (!(error instanceof ZoteroError && error.code === 'NOT_FOUND')) throw error
    }
    if (found === undefined && client.via === 'cloud') {
      const data = await client.cloudFile(`${libraryPath(ref.library)}/items/${attachment.key}/file`, signal)
      if (data === undefined) throw new Error('zotero.org has neither indexed text nor the file of this attachment (files are only there when the library syncs them to Zotero storage). Its text can be read once Zotero runs on this computer.')
      const name = (attachment.data.filename ?? '').toLowerCase()
      const type = attachment.data.contentType ?? ''
      if (type === 'application/pdf' || name.endsWith('.pdf')) found = { text: await (host.pdfData ?? pdfText)(data), source: 'the PDF in Zotero\'s online storage' }
      else if (type.startsWith('text/') || /\.(txt|md|html?)$/.test(name)) {
        const raw = new TextDecoder().decode(data)
        found = { text: type.includes('html') || /\.html?$/.test(name) ? htmlToText(raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')) : raw, source: 'the file in Zotero\'s online storage' }
      } else throw new Error(`This attachment is a ${type || 'file of unknown type'}; its text cannot be read here.`)
      if (found.text.trim() === '') throw new Error('The PDF has no text layer (it looks like a scan). Its text cannot be read without OCR.')
    }
    if (found === undefined) {
      const path = await attachmentPath(host, { library: ref.library, key: attachment.key }, signal)
      if (path === undefined || !(await access(path).then(() => true, () => false))) {
        throw new Error('Zotero has no indexed text for this attachment and its file is not on this computer (it may not have been downloaded yet: open it once in Zotero).')
      }
      const extension = extname(path).toLowerCase()
      if (extension === '.pdf') found = { text: await (host.pdfText ?? pdfFileText)(path), source: 'the PDF file' }
      else if (['.txt', '.md', '.html', '.htm'].includes(extension)) {
        const raw = await readFile(path, 'utf8')
        found = { text: extension.startsWith('.htm') ? htmlToText(raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')) : raw, source: 'the attached file' }
      } else throw new Error(`This attachment is a ${extension || 'file without extension'}; its text cannot be read here. Its path: ${path}`)
      if (found.text.trim() === '') throw new Error('The PDF has no text layer (it looks like a scan). Its text cannot be read without OCR.')
    }
    texts.set(cacheKey, found)
    if (texts.size > 4) texts.delete(texts.keys().next().value!)
    return found
  }

  tools.push(defineTool({
    name: 'zotero_search',
    description: 'Search the user\'s Zotero library. Returns numbered hits with a ref each; pass a ref to zotero_get, zotero_read or zotero_export. Without query it lists items (newest first), optionally within a collection, a saved search or by tag.',
    parameters: {
      query: { type: 'string', description: 'Words to look for. Zotero matches all of them; there are no operators.' },
      mode: { type: 'string', enum: ['metadata', 'everything'], description: 'metadata (default): title, creators, year. everything: every field, notes and the indexed text of attachments; slower.' },
      collection: { type: 'string', description: 'Limit to one collection: its ref, name or "Parent / Child" path.' },
      saved_search: { type: 'string', description: 'Run one of the user\'s saved searches (ref from zotero_browse kind=searches).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only items carrying all of these tags.' },
      item_type: { type: 'string', description: 'One Zotero item type such as journalArticle, conferencePaper, book, thesis, preprint, report.' },
      sort: { type: 'string', enum: ['dateAdded', 'dateModified', 'date', 'title', 'creator'], description: 'Default dateAdded.' },
      direction: { type: 'string', enum: ['asc', 'desc'] },
      limit: { type: 'integer', description: 'How many hits (default 10).' },
      start: { type: 'integer', description: 'Skip this many hits; for the next page.' },
      library: LIBRARY_PARAM,
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<Value> {
      const input = args as { query?: string; mode?: string; collection?: string; saved_search?: string; tags?: string[]; item_type?: string; sort?: string; direction?: string; limit?: number; start?: number; library?: string }
      const library = libraryFor(host, input.library)
      const max = host.settings().maxResults
      const limit = Math.min(max, Math.max(1, input.limit ?? Math.min(10, max)))
      const start = Math.max(0, input.start ?? 0)
      const query = input.query?.trim() ?? ''
      const everything = input.mode === 'everything' && query !== ''
      let scope = libraryPath(library)
      let where = ''
      if (input.collection?.trim()) {
        const collection = await findCollection(host, library, input.collection, exec.signal)
        scope += `/collections/${collection.key}`
        where = ` in collection "${collection.path}"`
      } else if (input.saved_search?.trim()) {
        scope += `/searches/${parseRef(input.saved_search, library).key}`
        where = ' in the saved search'
      }
      const filters = {
        ...(query === '' ? {} : { q: query, qmode: everything ? 'everything' : 'titleCreatorYear' }),
        ...(input.tags === undefined || input.tags.length === 0 ? {} : { tag: input.tags }),
        sort: input.sort ?? 'dateAdded',
        ...(input.direction === undefined ? {} : { direction: input.direction }),
      }
      let items: Item[]
      let total: number | undefined
      // A hit in a note, in the text of a PDF or on a tagged highlight is a child item; the answer is the paper it belongs to.
      const lifted = everything || (input.tags?.length ?? 0) > 0
      try {
      if (!lifted) {
        const page = await client.json<Item[]>(`${scope}/items/top`, { ...filters, ...(input.item_type ? { itemType: input.item_type } : {}), limit, start }, exec.signal)
        items = page.data
        total = page.total
      } else {
        const hits = (await client.json<Item[]>(`${scope}/items`, { ...filters, limit: Math.min(300, (start + limit) * 4) }, exec.signal)).data
        const known = new Map(hits.map(hit => [hit.key, hit]))
        const top = async (item: Item): Promise<Item | undefined> => {
          let current: Item | undefined = item
          // annotation -> attachment -> paper: at most two steps up.
          for (let step = 0; step < 2 && current?.data.parentItem; step++) {
            const parentKey: string = current.data.parentItem
            if (!known.has(parentKey)) {
              const parent = await client.json<Item>(`${libraryPath(library)}/items/${parentKey}`, undefined, exec.signal).then(page => page.data, () => undefined)
              if (parent === undefined) return undefined
              known.set(parentKey, parent)
            }
            current = known.get(parentKey)
          }
          return current
        }
        const all: Item[] = []
        for (const hit of hits) {
          const item = await top(hit)
          if (item !== undefined && !all.some(have => have.key === item.key) && (!input.item_type || item.data.itemType === input.item_type)) all.push(item)
        }
        items = all.slice(start, start + limit)
        total = all.length
      }
      } catch (error) {
        // zotero.org stores saved searches but does not run them.
        if (input.saved_search?.trim() && client.via === 'cloud' && error instanceof ZoteroError && ['NOT_FOUND', 'BAD_REQUEST', 'HTTP'].includes(error.code)) {
          throw new Error('A saved search can only be run by the Zotero on this computer, which is not running; zotero.org does not run saved searches. Search by words, tags or collection instead.')
        }
        throw error
      }
      if (items.length === 0) {
        return { text: `No items${query ? ` match "${query}"` : ''}${where}${start > 0 ? ` from position ${String(start)}` : ''}. ${query && !everything ? 'mode=everything also looks inside notes, abstracts and the text of PDFs. ' : ''}Nothing found here does not mean the paper does not exist.` }
      }
      const shown = `${String(start + 1)}–${String(start + items.length)}`
      const more = total !== undefined && start + items.length < total
      const head = `Zotero: ${total === undefined ? String(items.length) : String(total)} item${total === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}${where}; showing ${shown}.${more ? ` Next page: start=${String(start + items.length)}.` : ''}${cloudNote(host)}`
      return { text: `${head}\n${untrusted(items.map((item, index) => formatHit(item, library, start + index + 1, 200)).join('\n'))}` }
    },
    presentCall: args => ({ card: 'generic', title: `Zotero 检索：${String((args as { query?: string }).query ?? '全部条目').slice(0, 40)}`, kind: 'search' }),
  }))

  tools.push(defineTool({
    name: 'zotero_browse',
    description: 'List what a Zotero library is organised into: its collections (as a tree), tags, saved searches, or the libraries themselves (personal and groups).',
    parameters: {
      kind: { type: 'string', required: true, enum: ['collections', 'tags', 'searches', 'libraries'] },
      query: { type: 'string', description: 'Only names containing this text.' },
      limit: { type: 'integer', description: 'How many rows (default 50).' },
      start: { type: 'integer', description: 'Skip this many rows.' },
      library: LIBRARY_PARAM,
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<Value> {
      const input = args as { kind: string; query?: string; limit?: number; start?: number; library?: string }
      const library = libraryFor(host, input.library)
      const limit = Math.min(200, Math.max(1, input.limit ?? 50))
      const start = Math.max(0, input.start ?? 0)
      const needle = input.query?.trim().toLowerCase() ?? ''
      let rows: string[]
      if (input.kind === 'libraries') {
        const groups = (await client.json<Array<{ id: number; data?: { name?: string } }>>('users/0/groups', undefined, exec.signal)).data
        rows = ['My Library — library: "user"', ...groups.map(group => `${group.data?.name ?? 'Group'} — library: "${String(group.id)}"`)]
      } else if (input.kind === 'collections') {
        const collections = await listCollections(host, library, exec.signal)
        const paths = collectionPaths(collections)
        rows = collections
          .map(collection => ({ path: paths.get(collection.key)!, line: `${paths.get(collection.key)!} (${String(collection.meta?.numItems ?? 0)} items) ${formatRef(library, collection.key, 'collection')}` }))
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(row => row.line)
      } else if (input.kind === 'tags') {
        const tags = (await client.json<Array<{ tag: string; meta?: { numItems?: number } }>>(`${libraryPath(library)}/tags`, undefined, exec.signal)).data
        rows = tags.sort((a, b) => (b.meta?.numItems ?? 0) - (a.meta?.numItems ?? 0)).map(tag => `${tag.tag} (${String(tag.meta?.numItems ?? 0)})`)
      } else {
        const searches = (await client.json<Array<{ key: string; data: { name: string } }>>(`${libraryPath(library)}/searches`, undefined, exec.signal)).data
        rows = searches.map(search => `${search.data.name} ${formatRef(library, search.key, 'search')}`)
      }
      const matching = needle === '' ? rows : rows.filter(row => row.toLowerCase().includes(needle))
      if (matching.length === 0) return { text: `No ${input.kind}${needle ? ` containing "${needle}"` : ''}.` }
      const page = matching.slice(start, start + limit)
      const more = start + page.length < matching.length ? ` Next page: start=${String(start + page.length)}.` : ''
      return { text: `${String(matching.length)} ${input.kind}; showing ${String(start + 1)}–${String(start + page.length)}.${more}\n${untrusted(page.join('\n'))}` }
    },
    presentCall: args => card(`Zotero 浏览：${String((args as { kind?: string }).kind ?? '')}`),
  }))

  tools.push(defineTool({
    name: 'zotero_get',
    description: 'Everything Zotero holds on one item: all metadata, abstract, tags, collections, plus its notes, attachments and the highlights and comments the user made in its PDFs.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Item ref from zotero_search.' },
      include: { type: 'array', items: { type: 'string', enum: ['notes', 'attachments', 'annotations'] }, description: 'Which children to add. Default: all three.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<Value> {
      const input = args as { ref: string; include?: string[] }
      const ref = refOf(host, input.ref)
      const include = new Set(input.include ?? ['notes', 'attachments', 'annotations'])
      const item = await getItem(host, ref, exec.signal)
      const names = (item.data.collections?.length ?? 0) > 0 ? collectionPaths(await listCollections(host, ref.library, exec.signal)) : new Map<string, string>()
      const parts = [formatItem(item, ref.library, names)]
      const isAttachment = item.data.itemType === 'attachment'
      const kids = isAttachment || item.data.itemType === 'note' || item.data.itemType === 'annotation' ? [] : await children(host, ref, exec.signal)
      const attachments = isAttachment ? [item] : kids.filter(kid => kid.data.itemType === 'attachment')
      if (include.has('attachments') && !isAttachment && attachments.length > 0) {
        parts.push(`attachments (${String(attachments.length)}):\n${attachments.map(attachment => formatAttachment(attachment, ref.library)).join('\n')}`)
      }
      if (include.has('notes')) {
        const notes = item.data.itemType === 'note' ? [item] : kids.filter(kid => kid.data.itemType === 'note')
        for (const note of notes.slice(0, 20)) parts.push(`note ${formatRef(ref.library, note.key)}:\n${clip(htmlToText(note.data.note ?? ''), 3_000)}`)
        if (notes.length > 20) parts.push(`(${String(notes.length - 20)} more notes not shown)`)
      }
      if (include.has('annotations')) {
        for (const attachment of attachments.filter(file => file.data.linkMode !== 'linked_url').slice(0, 5)) {
          // Annotations hang off the attachment and are left out unless asked for by type.
          const annotations = await children(host, { library: ref.library, key: attachment.key }, exec.signal, { itemType: 'annotation' }).catch(() => [] as Item[])
          const marked = annotations.filter(annotation => annotation.data.itemType === 'annotation')
          if (marked.length === 0) continue
          parts.push(`annotations in "${attachment.data.title || attachment.data.filename || attachment.key}" (${String(marked.length)}):\n${marked.slice(0, 150).map(formatAnnotation).join('\n')}${marked.length > 150 ? `\n(${String(marked.length - 150)} more not shown)` : ''}`)
        }
      }
      return { text: untrusted(parts.join('\n\n')) }
    },
    presentCall: () => card('读取 Zotero 条目'),
  }))

  tools.push(defineTool({
    name: 'zotero_read',
    description: 'Read the text of a paper in Zotero (its PDF or snapshot). With query it returns the passages that best match; without, the text itself in chunks (continue with start). Page markers like [page 3] come from the PDF.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Ref of the item, or of one attachment when the item has several.' },
      query: { type: 'string', description: 'What to look for in the text. Returns the best matching passages instead of a chunk.' },
      passages: { type: 'integer', description: 'With query: how many passages (default 5, at most 12).' },
      start: { type: 'integer', description: 'Without query: character offset to continue from (the next_start of the previous call).' },
      max_chars: { type: 'integer', description: 'Without query: size of the chunk. Default from settings.' },
    },
    output,
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { ref: string; query?: string; passages?: number; start?: number; max_chars?: number }
      const ref = refOf(host, input.ref)
      const item = await getItem(host, ref, exec.signal)
      let attachment: Item | undefined = item
      let title = item.data.title ?? ''
      if (item.data.itemType !== 'attachment') {
        attachment = bestAttachment(await children(host, ref, exec.signal))
        if (attachment === undefined) throw new Error('This item has no file attached in Zotero, so there is no text to read. Its metadata and abstract are in zotero_get.')
      } else if (item.data.parentItem) {
        title = (await getItem(host, { library: ref.library, key: item.data.parentItem }, exec.signal).catch(() => item)).data.title ?? title
      }
      const { text, source } = await fullText(attachment, ref, exec.signal)
      const head = `"${title || attachment.data.title || '(untitled)'}" — ${String(text.length)} characters, read from ${source}.${cloudNote(host)}`
      const query = input.query?.trim() ?? ''
      if (query !== '') {
        const found = rankPassages(text, query, Math.min(12, Math.max(1, input.passages ?? 5)))
        if (found.length === 0) return { text: `${head}\nNo passage matches "${query}". Try other words, or read the text in chunks without query.` }
        return { text: `${head}\nBest passages for "${query}" (offset = position in the text):\n${untrusted(found.map(passage => `--- offset ${String(passage.start)} ---\n${passage.text.trim()}`).join('\n\n'))}` }
      }
      const start = Math.min(text.length, Math.max(0, input.start ?? 0))
      const size = Math.min(host.settings().maxContentChars, Math.max(500, input.max_chars ?? host.settings().maxContentChars))
      const end = Math.min(text.length, start + size)
      const tail = end < text.length ? `is_truncated: true, next_start: ${String(end)}` : 'is_truncated: false (end of text)'
      return { text: `${head}\nCharacters ${String(start)}–${String(end)}; ${tail}.\n${untrusted(text.slice(start, end))}` }
    },
    presentCall: args => card((args as { query?: string }).query ? '在 Zotero 文献中查找段落' : '阅读 Zotero 文献全文'),
  }))

  tools.push(defineTool({
    name: 'zotero_export',
    description: 'Export Zotero items as BibTeX, BibLaTeX, RIS or CSL JSON, or as formatted references and in-text citations in a citation style. The output comes from Zotero itself, so cite keys and formatting are exact: copy it, do not retype it.',
    parameters: {
      refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Item refs (up to 50).' },
      format: { type: 'string', required: true, enum: ['bibtex', 'biblatex', 'ris', 'csljson', 'bibliography', 'citation'], description: 'bibliography = formatted reference list entries; citation = in-text citations.' },
      style: { type: 'string', description: 'CSL style id for bibliography / citation, e.g. apa, ieee, nature, chicago-author-date, china-national-standard-gb-t-7714-2015-numeric. Zotero fetches a style it does not have from zotero.org/styles. Default from settings.' },
      locale: { type: 'string', description: 'Language of the style terms, e.g. en-US, zh-CN.' },
    },
    output,
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { refs: string[]; format: string; style?: string; locale?: string }
      const refs = input.refs.slice(0, 50).map(ref => refOf(host, ref))
      if (refs.length === 0) throw new Error('refs is empty.')
      const groups = new Map<string, Ref[]>()
      for (const ref of refs) groups.set(libraryPath(ref.library), [...(groups.get(libraryPath(ref.library)) ?? []), ref])
      const formatted = input.format === 'bibliography' || input.format === 'citation'
      const style = input.style?.trim() || host.settings().citationStyle
      const blocks: string[] = []
      for (const [path, group] of groups) {
        const itemKey = group.map(ref => ref.key).join(',')
        try {
          if (!formatted) {
            blocks.push((await client.text(`${path}/items`, { itemKey, format: input.format }, exec.signal)).trim())
            continue
          }
          const items = (await client.json<Array<Item & { bib?: string; citation?: string }>>(`${path}/items`, { itemKey, format: 'json', include: input.format === 'citation' ? 'citation' : 'bib', style, ...(input.locale ? { locale: input.locale } : {}) }, exec.signal)).data
          const byKey = new Map(items.map(item => [item.key, item]))
          blocks.push(group.map(ref => {
            const item = byKey.get(ref.key)
            return item === undefined ? `(not found: ${formatRef(ref.library, ref.key)})` : htmlToText((input.format === 'citation' ? item.citation : item.bib) ?? '')
          }).join('\n'))
        } catch (error) {
          if (formatted && error instanceof ZoteroError && (error.code === 'BAD_REQUEST' || error.code === 'HTTP')) {
            throw new Error(`Zotero could not format with style "${style}": ${error.message} Use the id of a style installed in Zotero (Settings > Cite) or listed at zotero.org/styles.`)
          }
          throw error
        }
      }
      const label = formatted ? `${input.format}, style ${style}` : input.format
      return { text: `Exported ${String(refs.length)} item${refs.length === 1 ? '' : 's'} from Zotero (${label}):\n${blocks.join('\n\n')}` }
    },
    presentCall: args => card(`从 Zotero 导出 ${String((args as { format?: string }).format ?? '')}`),
  }))

  tools.push(defineTool({
    name: 'zotero_attachment',
    description: 'Where the file of a Zotero item is on this computer (or the URL, for a web link attachment). Use it to hand the file to another tool; to read the text use zotero_read.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Ref of the item or of one attachment.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<Value> {
      const ref = refOf(host, (args as { ref: string }).ref)
      const item = await getItem(host, ref, exec.signal)
      const files = item.data.itemType === 'attachment' ? [item] : (await children(host, ref, exec.signal)).filter(kid => kid.data.itemType === 'attachment')
      if (files.length === 0) return { text: 'This item has no attachment in Zotero.' }
      const lines: string[] = []
      for (const file of files) {
        const name = file.data.title || file.data.filename || file.key
        if (file.data.linkMode === 'linked_url') { lines.push(`${name}: web link ${String(file.data.url ?? '')}`); continue }
        if (client.via === 'cloud') { lines.push(`${name} [${file.data.contentType ?? 'file'}] ${formatRef(ref.library, file.key)}: in the online library; its place on this computer is known only while Zotero runs here. zotero_read can still read its text.`); continue }
        const path = await attachmentPath(host, { library: ref.library, key: file.key }, exec.signal)
        const there = path !== undefined && await access(path).then(() => true, () => false)
        lines.push(`${name} [${file.data.contentType ?? 'file'}] ${formatRef(ref.library, file.key)}: ${path === undefined ? 'no file' : there ? path : `${path} (not on disk: not downloaded yet)`}`)
      }
      return { text: untrusted(lines.join('\n')) }
    },
    presentCall: () => card('定位 Zotero 附件'),
  }))

  return tools
}
