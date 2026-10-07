/**
 * The Zotero tools that change the library: add works by DOI or arXiv id,
 * write notes, tag and file items. Registered only when the user turned
 * writing on; each call is also confirmed through the host's approval prompt
 * (see ../index.ts) and through Zotero's own authorization dialog.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Http } from '../net/http.js'
import { untrusted } from '../net/untrusted.js'
import { arxivById, arxivId } from '../sources/arxiv.js'
import { parseWriteReport, type ZoteroWriter } from './auth.js'
import { doiOf, itemFromArxiv, itemFromCsl, minimalItem, type Csl, type NewItem } from './csl.js'
import type { Item } from './format.js'
import { markdownToHtml } from './markdown.js'
import { formatRef, libraryPath, type Library } from './refs.js'
import { card, findCollection, getItem, libraryFor, output, refOf, type ToolDefinition, type Value, type ZoteroHost } from './tools.js'

export interface ZoteroWriteHost extends ZoteroHost {
  writer: ZoteroWriter
  http: Http
}

export const WRITE_TOOLS = ['zotero_add', 'zotero_note', 'zotero_organize'] as const

interface Written { key: string; data?: { title?: string } }

export function createWriteTools(host: ZoteroWriteHost): ToolDefinition[] {
  const { client, writer, http } = host
  const tools: ToolDefinition[] = []

  const postItems = async (library: Library, items: unknown[], signal?: AbortSignal) =>
    parseWriteReport<Written>(await writer.write(`${libraryPath(library)}/items`, { method: 'POST', body: items, signal, timeoutMs: 60_000 }))

  /** The item already in the library for this DOI or arXiv id, if any. */
  const existing = async (library: Library, id: string, signal?: AbortSignal): Promise<Item | undefined> => {
    const hits = (await client.json<Item[]>(`${libraryPath(library)}/items`, { q: id, qmode: 'everything', limit: 20 }, signal)).data
    const lower = id.toLowerCase()
    return hits.find(hit => !hit.data.parentItem && [hit.data.DOI, hit.data.url, hit.data.extra, hit.data.archiveID].some(field => typeof field === 'string' && field.toLowerCase().includes(lower)))
  }

  tools.push(defineTool({
    name: 'zotero_add',
    description: 'Add works to the user\'s Zotero library by DOI or arXiv id. The metadata is fetched from the DOI registry / arXiv, never typed by you. Works already in the library are reported, not duplicated. Changes the library: the user is asked to confirm.',
    parameters: {
      identifiers: { type: 'array', required: true, items: { type: 'string' }, description: 'DOIs (10.xxxx/…), arXiv ids (2401.12345) or their doi.org / arxiv.org URLs. Up to 20.' },
      collection: { type: 'string', description: 'Collection to file them in: its ref, name or "Parent / Child" path. Default: none (library root).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags to put on each added item.' },
      library: { type: 'string', description: 'Library to add to instead of the one in settings: "user" or a group id.' },
    },
    output,
    timeoutMs: 300_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { identifiers: string[]; collection?: string; tags?: string[]; library?: string }
      const library = libraryFor(host, input.library)
      const ids = [...new Set(input.identifiers.map(id => id.trim()).filter(Boolean))].slice(0, 20)
      if (ids.length === 0) throw new Error('identifiers is empty.')
      const collection = input.collection?.trim() ? await findCollection(host, library, input.collection, exec.signal) : undefined
      const lines: string[] = []
      const pending: Array<{ id: string; item: NewItem }> = []
      const links: Array<Record<string, string>> = []
      for (const id of ids) {
        const arxiv = arxivId(id)
        const doi = arxiv === undefined ? doiOf(id) : undefined
        if (arxiv === undefined && doi === undefined) { lines.push(`${id}: not a DOI or an arXiv id; skipped.`); continue }
        const known = await existing(library, arxiv ?? doi!, exec.signal)
        if (known !== undefined) { lines.push(`${id}: already in the library as "${known.data.title ?? ''}" ${formatRef(library, known.key)}`); continue }
        try {
          let item: NewItem
          if (arxiv !== undefined) {
            const paper = (await arxivById(http, [arxiv], exec.signal))[0]
            if (paper === undefined) { lines.push(`${id}: arXiv has no paper with this id.`); continue }
            item = itemFromArxiv(paper)
          } else {
            item = itemFromCsl(await http.json<Csl>(`https://doi.org/${encodeURI(doi!)}`, { headers: { accept: 'application/vnd.citationstyles.csl+json' }, signal: exec.signal }), doi!)
          }
          const tags = [...((item.tags as Array<{ tag: string }> | undefined) ?? []), ...(input.tags ?? []).map(tag => ({ tag }))]
          pending.push({ id, item: { ...item, ...(tags.length > 0 ? { tags } : {}), ...(collection === undefined ? {} : { collections: [collection.key] }) } })
        } catch (error) {
          if (exec.signal.aborted) throw error
          lines.push(`${id}: could not fetch its metadata (${error instanceof Error ? error.message : String(error)}). Not added.`)
        }
      }
      if (pending.length > 0) {
        const report = await postItems(library, pending.map(entry => entry.item), exec.signal)
        const retry: Array<{ id: string; item: NewItem; why: string }> = []
        pending.forEach((entry, index) => {
          const done = report.successful[String(index)]
          const failed = report.failed[String(index)]
          if (done !== undefined) {
            lines.push(`${entry.id}: added "${entry.item.title}" (${entry.item.itemType}) ${formatRef(library, done.key)}`)
            const arxiv = /^arXiv:(.+)$/.exec(String(entry.item.archiveID ?? ''))?.[1]
            if (arxiv !== undefined) links.push({ itemType: 'attachment', linkMode: 'linked_url', title: 'arXiv PDF', url: `https://arxiv.org/pdf/${arxiv}`, parentItem: done.key })
          }
          else retry.push({ ...entry, why: failed?.message ?? 'no answer for this item' })
        })
        if (retry.length > 0) {
          // Zotero refuses a whole item for one field it does not have on that type: keep what every type has.
          const second = await postItems(library, retry.map(entry => minimalItem(entry.item)), exec.signal)
          retry.forEach((entry, index) => {
            const done = second.successful[String(index)]
            lines.push(done !== undefined
              ? `${entry.id}: added "${entry.item.title}" with basic fields only ${formatRef(library, done.key)} (Zotero refused the full record: ${entry.why})`
              : `${entry.id}: Zotero refused it (${second.failed[String(index)]?.message ?? entry.why}). Not added.`)
          })
        }
      }
      // An arXiv paper gets a link to its PDF; a link that fails to attach is no reason to fail the add.
      if (links.length > 0) await postItems(library, links, exec.signal).catch(() => {})
      return { text: `${collection === undefined ? '' : `Collection: ${collection.path}\n`}${untrusted(lines.join('\n'))}` }
    },
    presentCall: args => card(`添加到 Zotero：${String(((args as { identifiers?: string[] }).identifiers ?? []).length)} 篇`, 'edit'),
  }))

  tools.push(defineTool({
    name: 'zotero_note',
    description: 'Write a note in Zotero: a new note under an item (parent), a new standalone note, or more text appended to an existing note (note). Write Markdown; it is stored as a formatted Zotero note. Changes the library: the user is asked to confirm.',
    parameters: {
      markdown: { type: 'string', required: true, description: 'The note text in Markdown (headings, lists, bold, links, quotes).' },
      parent: { type: 'string', description: 'Ref of the item the new note belongs to. Omit for a standalone note.' },
      note: { type: 'string', description: 'Ref of an existing note to append to, instead of creating one.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for a new note.' },
    },
    output,
    timeoutMs: 240_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { markdown: string; parent?: string; note?: string; tags?: string[] }
      const html = markdownToHtml(input.markdown)
      if (html.trim() === '') throw new Error('markdown is empty.')
      if (input.note?.trim()) {
        const ref = refOf(host, input.note)
        const current = await getItem(host, ref, exec.signal)
        if (current.data.itemType !== 'note') throw new Error('note must be the ref of a note. To add a note to an item, pass the item as parent.')
        const report = await postItems(ref.library, [{ key: ref.key, version: current.version ?? current.data.version ?? 0, note: `${current.data.note ?? ''}\n${html}` }], exec.signal)
        if (report.failed['0'] !== undefined) throw new Error(`Zotero refused the change: ${report.failed['0'].message}`)
        return { text: `Appended to the note ${formatRef(ref.library, ref.key)}.` }
      }
      const parent = input.parent?.trim() ? refOf(host, input.parent) : undefined
      const library = parent?.library ?? libraryFor(host)
      if (parent !== undefined) {
        const item = await getItem(host, parent, exec.signal)
        if (item.data.itemType === 'note' || item.data.itemType === 'attachment' || item.data.itemType === 'annotation') throw new Error('parent must be a regular item (a paper, a book …), not a note or an attachment.')
      }
      const report = await postItems(library, [{
        itemType: 'note',
        note: html,
        ...(parent === undefined ? {} : { parentItem: parent.key }),
        tags: (input.tags ?? []).map(tag => ({ tag })),
      }], exec.signal)
      const done = report.successful['0']
      if (done === undefined) throw new Error(`Zotero refused the note: ${report.failed['0']?.message ?? 'no reason given'}`)
      return { text: `Note created ${formatRef(library, done.key)}${parent === undefined ? ' (standalone)' : ` under ${formatRef(library, parent.key)}`}.` }
    },
    presentCall: args => card((args as { note?: string }).note ? '追加 Zotero 笔记' : '新建 Zotero 笔记', 'edit'),
  }))

  tools.push(defineTool({
    name: 'zotero_organize',
    description: 'Tag and file Zotero items: add or remove tags, add to or remove from collections, and create a collection. Nothing is deleted from the library. Changes the library: the user is asked to confirm.',
    parameters: {
      refs: { type: 'array', items: { type: 'string' }, description: 'Items to change (up to 50, all in one library).' },
      add_tags: { type: 'array', items: { type: 'string' } },
      remove_tags: { type: 'array', items: { type: 'string' } },
      add_collections: { type: 'array', items: { type: 'string' }, description: 'Collections by ref, name or "Parent / Child" path.' },
      remove_collections: { type: 'array', items: { type: 'string' } },
      create_collection: { type: 'string', description: 'Name of a collection to create; the refs, if any, are added to it.' },
      create_in: { type: 'string', description: 'Parent collection for create_collection. Default: top level.' },
    },
    output,
    timeoutMs: 240_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { refs?: string[]; add_tags?: string[]; remove_tags?: string[]; add_collections?: string[]; remove_collections?: string[]; create_collection?: string; create_in?: string }
      const refs = (input.refs ?? []).slice(0, 50).map(ref => refOf(host, ref))
      const library = refs[0]?.library ?? libraryFor(host)
      if (refs.some(ref => libraryPath(ref.library) !== libraryPath(library))) throw new Error('All refs must be in one library; call once per library.')
      const lines: string[] = []
      const adding = await Promise.all((input.add_collections ?? []).map(name => findCollection(host, library, name, exec.signal)))
      const removing = await Promise.all((input.remove_collections ?? []).map(name => findCollection(host, library, name, exec.signal)))
      const name = input.create_collection?.trim()
      if (name) {
        const parent = input.create_in?.trim() ? await findCollection(host, library, input.create_in, exec.signal) : undefined
        const report = parseWriteReport<{ key: string }>(await writer.write(`${libraryPath(library)}/collections`, { method: 'POST', body: [{ name, ...(parent === undefined ? {} : { parentCollection: parent.key }) }], signal: exec.signal }))
        const made = report.successful['0']
        if (made === undefined) throw new Error(`Zotero refused the collection: ${report.failed['0']?.message ?? 'no reason given'}`)
        adding.push({ key: made.key, path: parent === undefined ? name : `${parent.path} / ${name}` })
        lines.push(`Created collection "${adding.at(-1)!.path}" ${formatRef(library, made.key, 'collection')}`)
      }
      const addTags = (input.add_tags ?? []).map(tag => tag.trim()).filter(Boolean)
      const dropTags = new Set((input.remove_tags ?? []).map(tag => tag.trim()))
      if (refs.length > 0 && addTags.length + dropTags.size + adding.length + removing.length === 0) throw new Error('Nothing to change: give tags or collections to add or remove.')
      if (refs.length === 0 && !name) throw new Error('Give refs to change, or create_collection.')
      const updates: Array<Record<string, unknown>> = []
      const titles: string[] = []
      for (const ref of refs) {
        const item = await getItem(host, ref, exec.signal)
        const tags = [...(item.data.tags ?? []).filter(tag => !dropTags.has(tag.tag)), ...addTags.filter(tag => !(item.data.tags ?? []).some(have => have.tag === tag)).map(tag => ({ tag }))]
        const update: Record<string, unknown> = { key: ref.key, version: item.version ?? item.data.version ?? 0, tags }
        // Only top-level items sit in collections; a note or attachment follows its parent.
        if (!item.data.parentItem && adding.length + removing.length > 0) {
          const gone = new Set(removing.map(collection => collection.key))
          update.collections = [...new Set([...(item.data.collections ?? []).filter(key => !gone.has(key)), ...adding.map(collection => collection.key)])]
        }
        updates.push(update)
        titles.push(item.data.title || ref.key)
      }
      if (updates.length > 0) {
        const report = await postItems(library, updates, exec.signal)
        const failed = Object.entries(report.failed)
        lines.push(`Updated ${String(updates.length - failed.length)} of ${String(updates.length)} item${updates.length === 1 ? '' : 's'}.`)
        for (const [index, failure] of failed) lines.push(`Not changed: "${titles[Number(index)] ?? ''}" (${failure.message})`)
        const changes = [
          addTags.length > 0 ? `tags added: ${addTags.join(', ')}` : '',
          dropTags.size > 0 ? `tags removed: ${[...dropTags].join(', ')}` : '',
          adding.length > 0 ? `added to: ${adding.map(collection => collection.path).join('; ')}` : '',
          removing.length > 0 ? `removed from: ${removing.map(collection => collection.path).join('; ')}` : '',
        ].filter(Boolean)
        if (changes.length > 0) lines.push(changes.join(' · '))
      }
      return { text: untrusted(lines.join('\n')) }
    },
    presentCall: () => card('整理 Zotero 条目', 'edit'),
  }))

  return tools
}
