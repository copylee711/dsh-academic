/** arXiv: metadata by id from the Atom API (`export.arxiv.org/api/query`). */
import { XMLParser } from 'fast-xml-parser'
import type { Http } from '../net/http.js'

export interface ArxivPaper {
  /** Id without version, e.g. `2401.12345` or `hep-th/9901001`. */
  id: string
  version?: string
  title: string
  authors: string[]
  abstract: string
  /** ISO date of the first version. */
  published: string
  updated?: string
  categories: string[]
  doi?: string
  journalRef?: string
  comment?: string
}

const NEW_ID = /(\d{4}\.\d{4,5})(v\d+)?/
const OLD_ID = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/

/** The arXiv id in an id, an `arXiv:` label, an arxiv.org URL or an arXiv DOI; undefined when there is none. */
export function arxivId(input: string): string | undefined {
  const text = input.trim()
  const scoped = /arxiv\.org\/(?:abs|pdf|html)\/([^\s?#]+)/i.exec(text)?.[1] ?? /^(?:arxiv:|10\.48550\/arxiv\.)(.+)$/i.exec(text)?.[1] ?? text
  const match = new RegExp(`^${NEW_ID.source}(?:\\.pdf)?$`).exec(scoped) ?? new RegExp(`^${OLD_ID.source}(?:\\.pdf)?$`).exec(scoped)
  return match?.[1]
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: name => name === 'entry' || name === 'author' || name === 'category' || name === 'link' })

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : typeof value === 'object' && value !== null ? String((value as { '#text'?: unknown })['#text'] ?? '') : '').replace(/\s+/g, ' ').trim()

export function parseArxivAtom(xml: string): ArxivPaper[] {
  const feed = (parser.parse(xml) as { feed?: { entry?: Array<Record<string, unknown>> } }).feed
  const papers: ArxivPaper[] = []
  for (const entry of feed?.entry ?? []) {
    const raw = /abs\/(.+)$/.exec(text(entry.id))?.[1] ?? ''
    const id = raw.replace(/v\d+$/, '')
    const title = text(entry.title)
    // A wrong id answers with an entry titled "Error".
    if (id === '' || title === '' || title === 'Error') continue
    const version = /v\d+$/.exec(raw)?.[0]
    const doi = text(entry['arxiv:doi'])
    const journalRef = text(entry['arxiv:journal_ref'])
    const comment = text(entry['arxiv:comment'])
    const updated = text(entry.updated)
    papers.push({
      id,
      ...(version === undefined ? {} : { version }),
      title,
      authors: ((entry.author as Array<{ name?: unknown }> | undefined) ?? []).map(author => text(author.name)).filter(Boolean),
      abstract: text(entry.summary),
      published: text(entry.published),
      ...(updated ? { updated } : {}),
      categories: ((entry.category as Array<{ '@term'?: string }> | undefined) ?? []).map(category => category['@term'] ?? '').filter(Boolean),
      ...(doi ? { doi } : {}),
      ...(journalRef ? { journalRef } : {}),
      ...(comment ? { comment } : {}),
    })
  }
  return papers
}

export async function arxivById(http: Http, ids: readonly string[], signal?: AbortSignal): Promise<ArxivPaper[]> {
  if (ids.length === 0) return []
  const url = `https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${String(ids.length)}`
  return parseArxivAtom(await http.text(url, { signal, timeoutMs: 30_000 }))
}
