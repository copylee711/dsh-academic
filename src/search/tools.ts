/**
 * The paper tools: search the scholarly indexes, look one paper up, follow
 * its citations, read its open-access text, get an exact citation, check a
 * reference list, save an open PDF.
 */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { findSection, outlineOf } from '../fulltext/markup.js'
import { isPublicUrl, parsePaperId, resolveFullText, type FullText, type PaperId, type TextCache } from '../fulltext/resolve.js'
import type { WebBrowser } from '../browser/session.js'
import type { Http } from '../net/http.js'
import { untrusted } from '../net/untrusted.js'
import type { Settings } from '../settings.js'
import { arxivById } from '../sources/arxiv.js'
import { crossrefWork, epmcRecord, openalexLinked, openalexWork, paperFromArxiv, paperFromCrossref, s2Paper, SEARCHERS, type Keys, type Query, type Reach } from '../sources/indexes.js'
import { rankPassages } from '../zotero/retrieve.js'
import { bestId, formatPaper, formatPaperDetail, mergeRanked, SOURCE_IDS, SOURCE_NAMES, titleKey, type Paper, type SourceId } from './paper.js'
import { formatChecked, verifyReference } from './verify.js'

type ToolDefinition = ReturnType<typeof defineTool>

export interface PaperHost {
  settings(): Settings
  http: Http
  cache: TextCache
  pdfText(data: Uint8Array): Promise<string>
  /** The plugin's browser for CNKI and Google Scholar. */
  browser?: WebBrowser
  /** The clock; replaced in tests. */
  now?(): Date
}

/** What the result card shows: the papers of a search, without their abstracts. */
export interface CardPaper { title: string; authors: string; year?: number; venue?: string; url?: string; citations?: number; open?: boolean }
interface Value { text: string; papers?: CardPaper[]; label?: string }

const CARD_PAPER = {
  type: 'object', additionalProperties: false, properties: {
    title: { type: 'string', required: true }, authors: { type: 'string', required: true }, year: { type: 'integer' }, venue: { type: 'string' },
    url: { type: 'string' }, citations: { type: 'integer' }, open: { type: 'boolean' },
  },
} as const

const output = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, papers: { type: 'array', items: CARD_PAPER }, label: { type: 'string' } } },
  render: (_args: unknown, value: Value) => [{ type: 'text' as const, text: value.text }],
  presentationMeta: (_args: unknown, value: Value) => (value.papers === undefined ? { kind: 'copylee-academic' } : { kind: 'copylee-academic-papers', label: value.label ?? '', papers: value.papers as unknown as Array<Record<string, string | number | boolean>> }),
} as const

const cardOf = (paper: Paper): CardPaper => ({
  title: paper.title,
  authors: paper.authors.length <= 3 ? paper.authors.join(', ') : `${paper.authors[0]!} et al.`,
  ...(paper.year === undefined ? {} : { year: paper.year }),
  ...(paper.venue === undefined ? {} : { venue: paper.venue }),
  ...(paper.url === undefined ? {} : { url: paper.url }),
  ...(paper.citations === undefined ? {} : { citations: paper.citations }),
  ...(paper.pdfUrl !== undefined || paper.openAccess === true ? { open: true } : {}),
})

const keysOf = (settings: Settings): Keys => ({
  ...(settings.email ? { email: settings.email } : {}),
  ...(settings.s2Key ? { s2Key: settings.s2Key } : {}),
  ...(settings.openalexKey ? { openalexKey: settings.openalexKey } : {}),
  ...(settings.ncbiKey ? { ncbiKey: settings.ncbiKey } : {}),
})

const CITE = 'Cite a paper from these results as a Markdown link on its title or as [n](url), using the url shown.'

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createPaperTools(host: PaperHost): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  const reachOf = (signal?: AbortSignal): Reach => ({ http: host.http, keys: keysOf(host.settings()), signal, ...(host.browser !== undefined && host.settings().browser ? { browser: host.browser } : {}) })

  /** Everything the indexes know about one paper, merged; undefined when none of them has it. */
  const lookup = async (id: PaperId | undefined, raw: string, reach: Reach): Promise<Paper | undefined> => {
    const quiet = async <T>(work: Promise<T>): Promise<T | undefined> => { try { return await work } catch (error) { if (reach.signal?.aborted) throw error; return undefined } }
    const found: Paper[][] = []
    const add = (paper: Paper | undefined): void => { if (paper !== undefined && paper.title !== '') found.push([paper]) }
    if (id === undefined) {
      // Not an id: take it as a title and trust the index only when the title really matches.
      const hits = await quiet(SEARCHERS.openalex({ query: raw, limit: 3, sort: 'relevance' }, reach)) ?? []
      const wanted = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      add(hits.find(hit => hit.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === wanted) ?? hits[0])
    } else if (id.kind === 'arxiv') {
      const [entry, s2, work] = await Promise.all([quiet(arxivById(reach.http, [id.id], reach.signal)), quiet(s2Paper(`ARXIV:${id.id}`, reach)), quiet(openalexWork(`doi:10.48550/arXiv.${id.id}`, reach))])
      add(entry?.[0] === undefined ? undefined : paperFromArxiv(entry[0])); add(work); add(s2)
      // OpenAlex files many preprints under the published version: find it by the exact title for the citation count.
      const title = entry?.[0]?.title
      if (work === undefined && title !== undefined) add((await quiet(SEARCHERS.openalex({ query: title, limit: 3, sort: 'relevance' }, reach)) ?? []).find(hit => titleKey(hit.title) === titleKey(title)))
    } else if (id.kind === 'doi') {
      const [work, record, s2, pmc] = await Promise.all([quiet(openalexWork(`doi:${id.id}`, reach)), quiet(crossrefWork(id.id, reach)), quiet(s2Paper(`DOI:${id.id}`, reach)), quiet(epmcRecord({ doi: id.id }, reach))])
      add(work)
      if (record !== undefined) add({ ...paperFromCrossref(record), ...((record['update-to'] ?? []).some(update => /retract|withdraw/i.test(update.type ?? '')) ? { retracted: true } : {}) })
      add(s2); add(pmc)
    } else if (id.kind === 'pmid' || id.kind === 'pmcid') {
      const record = await quiet(epmcRecord(id.kind === 'pmid' ? { pmid: id.id } : { pmcid: id.id }, reach))
      add(record)
      if (record?.doi !== undefined) add(await quiet(openalexWork(`doi:${record.doi}`, reach)))
      else if (id.kind === 'pmid') add(await quiet(openalexWork(`pmid:${id.id}`, reach)))
    }
    return mergeRanked(found)[0]
  }

  tools.push(defineTool({
    name: 'paper_search',
    description: 'Search the scholarly literature across arXiv, OpenAlex, Crossref, Semantic Scholar, PubMed, Europe PMC and DBLP at once; the same paper found in several is returned once. CNKI (Chinese journals and theses) and Google Scholar can be named in sources too: they are searched through a browser window, which takes 10 to 20 seconds and may stop for a human check the user has to answer. Use it for papers, not for general web pages. Each hit has an id to pass to paper_get, paper_read, paper_citations or paper_cite.',
    parameters: {
      query: { type: 'string', required: true, description: 'Topic words, a title, or an author with a topic. Plain keywords work in every index; write them in English unless the literature is in another language.' },
      sources: { type: 'array', items: { type: 'string', enum: [...SOURCE_IDS] }, description: 'Limit to these indexes. Default: the ones enabled in settings. arxiv for CS / physics / math preprints; pubmed and europepmc for medicine and biology; dblp for computer science venues; openalex and crossref for everything; cnki for literature in Chinese (query in Chinese); googlescholar when the others do not find a work that should exist.' },
      year_from: { type: 'integer', description: 'Published in this year or later.' },
      year_to: { type: 'integer', description: 'Published in this year or earlier.' },
      open_access: { type: 'boolean', description: 'Only papers with a free full text.' },
      sort: { type: 'string', enum: ['relevance', 'date', 'citations'], description: 'Default relevance. date = newest first; citations = most cited first.' },
      categories: { type: 'array', items: { type: 'string' }, description: 'arXiv categories such as cs.LG, cs.CL, stat.ML (arXiv only).' },
      limit: { type: 'integer', description: 'How many papers (default 8).' },
      abstract: { type: 'string', enum: ['none', 'snippet', 'full'], description: 'How much of each abstract to return. Default snippet.' },
    },
    output,
    isConcurrencySafe: () => true,
    // Long enough for the user to answer a human check in the browser window.
    timeoutMs: 240_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { query: string; sources?: string[]; year_from?: number; year_to?: number; open_access?: boolean; sort?: Query['sort']; categories?: string[]; limit?: number; abstract?: string }
      const settings = host.settings()
      const text = input.query.trim()
      if (text === '') throw new Error('query is empty.')
      const limit = Math.min(settings.maxResults, Math.max(1, input.limit ?? Math.min(8, settings.maxResults)))
      const asked = ((input.sources?.length ?? 0) > 0 ? input.sources! : settings.sources).filter((source): source is SourceId => (SOURCE_IDS as readonly string[]).includes(source))
      if (asked.length === 0) throw new Error('No index to search: every source is switched off in Settings > 学术.')
      const thisYear = (host.now?.() ?? new Date()).getFullYear()
      const newest = input.sort === 'date'
      // "Newest" means the recent papers on the topic: without a start year, look at this year and the last.
      const yearFrom = input.year_from ?? (newest ? thisYear - 1 : undefined)
      // Registries hold records dated decades ahead (typos, placeholders); a year window must not reach them.
      const yearTo = yearFrom === undefined && input.year_to === undefined ? undefined : Math.min(input.year_to ?? thisYear + 1, thisYear + 1)
      const query: Query = {
        // "Most cited" is sorted here, over what each index finds relevant: an index sorting by
        // citations returns famous papers that merely mention the words.
        query: text, sort: input.sort === 'citations' ? 'relevance' : input.sort ?? 'relevance',
        // Ask each index for a little more than wanted: after merging, some are the same paper.
        limit: Math.min(50, input.sort === 'citations' ? limit * 5 : asked.length === 1 ? limit : Math.max(5, Math.ceil(limit * 0.8))),
        ...(yearFrom === undefined ? {} : { yearFrom }), ...(yearTo === undefined ? {} : { yearTo }),
        ...(input.open_access === true ? { openAccess: true } : {}), ...((input.categories?.length ?? 0) > 0 ? { categories: input.categories! } : {}),
      }
      const reach = reachOf(exec.signal)
      const failed: string[] = []
      const lists = await Promise.all(asked.map(async source => {
        try {
          // Only arXiv's own date order stays on the topic (it wants every word). The others, sorted by
          // date, return whatever was registered last and mentions one word: ask them for what is
          // relevant in the window and order that by date here.
          return await SEARCHERS[source](newest && source !== 'arxiv' ? { ...query, sort: 'relevance', limit: Math.min(50, limit * 3) } : query, reach)
        } catch (error) {
          if (exec.signal.aborted) throw error
          failed.push(`${SOURCE_NAMES[source]} (${why(error)})`)
          return []
        }
      }))
      let papers = mergeRanked(lists)
      // A year that has not come yet is a mistake in the record, not a date to show or sort by.
      const sane = (paper: Paper): boolean => paper.year === undefined || paper.year <= thisYear + 1
      papers = newest ? papers.filter(sane) : papers.map(paper => { if (sane(paper)) return paper; const { year: _year, date: _date, ...rest } = paper; return rest })
      // A query that is a paper's title wants that paper first, whatever each index ranked above it.
      const wanted = titleKey(text)
      if ((input.sort ?? 'relevance') === 'relevance') papers = [...papers.filter(paper => titleKey(paper.title) === wanted), ...papers.filter(paper => titleKey(paper.title) !== wanted)]
      if (newest) {
        // A cover date still to come (an issue or a book series dated ahead) says the paper is recent, not
        // when it appeared: such papers go after those dated this month, not above everything.
        const today = (host.now?.() ?? new Date()).toISOString().slice(0, 10)
        const when = (paper: Paper): string => { const date = String(paper.date ?? paper.year ?? ''); return date.slice(0, 10) > today || date.slice(0, 4) > today.slice(0, 4) ? today.slice(0, 7) : date }
        papers.sort((a, b) => when(b).localeCompare(when(a)))
      }
      if (input.sort === 'citations') papers.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1))
      if (input.open_access === true) papers = papers.filter(paper => paper.pdfUrl !== undefined || paper.openAccess === true)
      papers = papers.slice(0, limit)
      const answered = asked.filter((_source, index) => lists[index]!.length > 0).map(source => SOURCE_NAMES[source])
      // arXiv, asked for the newest, wants every word of the query in the title or abstract; a long query finds nothing.
      const arxivAt = asked.indexOf('arxiv')
      const noPreprints = newest && arxivAt !== -1 && lists[arxivAt]!.length === 0 && !failed.some(entry => entry.startsWith('arXiv'))
        ? '\narXiv has no recent paper containing all of these words. For the newest preprints ask again with two or three keywords.' : ''
      const skipped = `${failed.length > 0 ? `\nNot answered: ${failed.join('; ')}.` : ''}${noPreprints}`
      if (papers.length === 0) {
        return { text: `No papers found for "${text}" in ${asked.map(source => SOURCE_NAMES[source]).join(', ')}.${skipped} Try fewer or different words; this does not mean no such paper exists.` }
      }
      const chars = input.abstract === 'none' ? 0 : input.abstract === 'full' ? 4_000 : 300
      return {
        text: `${String(papers.length)} papers for "${text}" (from ${answered.join(', ')}).${newest ? ` Newest first, among the papers each index finds relevant from ${String(yearFrom)} on.` : ''}${skipped}\n${CITE}\n${untrusted(papers.map((paper, index) => formatPaper(paper, index + 1, chars)).join('\n'))}`,
        papers: papers.map(cardOf),
        label: text,
      }
    },
    presentCall: args => ({ card: 'generic', title: `检索论文：${String((args as { query?: string }).query ?? '').slice(0, 40)}`, kind: 'search' }),
  }))

  tools.push(defineTool({
    name: 'paper_get',
    description: 'Look one paper up by DOI, arXiv id, PMID or PMCID (or by exact title): full abstract, authors, venue, citation count, open-access link, and whether it has been retracted. Merges what OpenAlex, Crossref, arXiv, Semantic Scholar and Europe PMC know.',
    parameters: {
      id: { type: 'string', required: true, description: 'DOI, arXiv id, PMID, PMCID, their URLs, or the exact title.' },
    },
    output,
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args, exec): Promise<Value> {
      const raw = (args as { id: string }).id.trim()
      const id = parsePaperId(raw)
      const paper = await lookup(id?.kind === 'url' ? undefined : id, raw, reachOf(exec.signal))
      if (paper === undefined) return { text: `No index has a paper for "${raw}". ${id === undefined ? 'Search for it with paper_search.' : 'Check the id; a made-up DOI looks exactly like this.'}` }
      return { text: `${id === undefined ? 'Closest match by title (check it is the paper meant):\n' : ''}${untrusted(formatPaperDetail(paper))}\nid for the other paper_ tools: ${bestId(paper)}`, papers: [cardOf(paper)], label: paper.title }
    },
    presentCall: () => ({ card: 'generic', title: '查询论文信息', kind: 'read' }),
  }))

  tools.push(defineTool({
    name: 'paper_citations',
    description: 'Follow a paper\'s citation links: the papers that cite it (most cited first), the papers it cites, or papers related to it. For finding follow-up work, the sources of a claim, or neighbours of a known paper.',
    parameters: {
      id: { type: 'string', required: true, description: 'DOI, arXiv id or PMID of the paper.' },
      direction: { type: 'string', required: true, enum: ['citations', 'references', 'related'], description: 'citations = papers citing it; references = its reference list; related = similar papers.' },
      limit: { type: 'integer', description: 'How many (default 10).' },
    },
    output,
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { id: string; direction: 'citations' | 'references' | 'related'; limit?: number }
      const id = parsePaperId(input.id)
      if (id === undefined || id.kind === 'url') throw new Error('Give a DOI, an arXiv id or a PMID. To find the id of a paper known by title, use paper_search.')
      const reach = reachOf(exec.signal)
      const limit = Math.min(host.settings().maxResults, Math.max(1, input.limit ?? 10))
      const work = await openalexWork(id.kind === 'arxiv' ? `doi:10.48550/arXiv.${id.id}` : id.kind === 'doi' ? `doi:${id.id}` : id.kind === 'pmid' ? `pmid:${id.id}` : `pmcid:${id.id}`, reach)
      if (work?.openalex === undefined) return { text: `OpenAlex, which holds the citation links, does not know ${input.id}. A recent preprint may not be indexed yet.` }
      const relation = input.direction === 'citations' ? 'cites' : input.direction === 'references' ? 'cited_by' : 'related_to'
      const { papers, total } = await openalexLinked(work.openalex, relation, limit, reach)
      const what = input.direction === 'citations' ? 'cite' : input.direction === 'references' ? 'are cited by' : 'are related to'
      if (papers.length === 0) return { text: `No papers that ${what} "${work.title}" in OpenAlex.` }
      const merged = mergeRanked([papers])
      return {
        text: `${total === undefined ? String(merged.length) : `${String(total)} papers`} ${what} "${work.title}"${total !== undefined && total > merged.length ? `; showing the ${String(merged.length)} most cited` : ''}.\n${CITE}\n${untrusted(merged.map((paper, index) => formatPaper(paper, index + 1, 200)).join('\n'))}`,
        papers: merged.map(cardOf),
        label: work.title,
      }
    },
    presentCall: args => ({ card: 'generic', title: (args as { direction?: string }).direction === 'references' ? '查看参考文献' : (args as { direction?: string }).direction === 'related' ? '查找相关论文' : '查看被引文献', kind: 'search' }),
  }))

  /** The text of a paper, fetched once. */
  const textOf = async (id: PaperId, signal: AbortSignal): Promise<FullText> => {
    const key = `${id.kind}-${id.id}`
    const cached = await host.cache.get(key)
    if (cached !== undefined) return cached
    const found = await resolveFullText(id, { reach: reachOf(signal), pdfText: host.pdfText })
    await host.cache.set(key, found)
    return found
  }

  tools.push(defineTool({
    name: 'paper_read',
    description: 'Read the full text of a paper that is openly available (arXiv, PubMed Central, or an open-access PDF). Start with outline=true to see the sections, then read one with section, or ask with query for the passages that answer a question; without those it returns the text in chunks. Paywalled papers cannot be read: the tool says so.',
    parameters: {
      id: { type: 'string', required: true, description: 'arXiv id, DOI, PMID, PMCID, or the URL of a PDF.' },
      outline: { type: 'boolean', description: 'Return the list of sections instead of text.' },
      section: { type: 'string', description: 'Read one section: its number from the outline, or (part of) its title, e.g. "Method".' },
      query: { type: 'string', description: 'Return the passages that best match this instead of a chunk.' },
      passages: { type: 'integer', description: 'With query: how many passages (default 5, at most 12).' },
      start: { type: 'integer', description: 'Character offset to continue from (the next_start of the previous call).' },
      max_chars: { type: 'integer', description: 'Size of the chunk. Default from settings.' },
    },
    output,
    isConcurrencySafe: () => true,
    timeoutMs: 180_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { id: string; outline?: boolean; section?: string; query?: string; passages?: number; start?: number; max_chars?: number }
      const id = parsePaperId(input.id)
      if (id === undefined) throw new Error('Give an arXiv id, a DOI, a PMID, a PMCID or a PDF URL. To find the id of a paper known by title, use paper_search.')
      const paper = await textOf(id, exec.signal)
      const sections = paper.structured ? outlineOf(paper.text) : []
      const head = `${input.id.trim()} — ${String(paper.text.length)} characters, read from ${paper.source}.${paper.url ? ` Source: ${paper.url}` : ''}`
      if (input.outline === true) {
        if (sections.length === 0) return { text: `${head}\nThis copy has no section headings (it was read from a PDF). Read it in chunks, or use query.` }
        return { text: `${head}\nSections (pass the number or the title as section):\n${untrusted(sections.map(section => `${'  '.repeat(Math.min(3, section.level - 1))}${section.id}. ${section.title} (${String(section.end - section.start)} chars)`).join('\n'))}` }
      }
      let text = paper.text
      let scope = ''
      if (input.section?.trim()) {
        const section = findSection(sections, input.section)
        if (section === undefined) throw new Error(sections.length === 0 ? 'This copy has no section headings; read it in chunks or use query.' : `No section "${input.section}". Sections: ${sections.filter(entry => entry.level <= 2).map(entry => `${entry.id}. ${entry.title}`).join('; ')}`)
        text = paper.text.slice(section.start, section.end)
        scope = ` Section ${section.id}: "${section.title}".`
      }
      const query = input.query?.trim() ?? ''
      if (query !== '') {
        const found = rankPassages(text, query, Math.min(12, Math.max(1, input.passages ?? 5)))
        if (found.length === 0) return { text: `${head}${scope}\nNo passage matches "${query}". Try other words, or read by section.` }
        return { text: `${head}${scope}\nBest passages for "${query}":\n${untrusted(found.map(passage => `--- offset ${String(passage.start)} ---\n${passage.text.trim()}`).join('\n\n'))}` }
      }
      const max = host.settings().maxContentChars
      const start = Math.min(text.length, Math.max(0, input.start ?? 0))
      const end = Math.min(text.length, start + Math.min(max, Math.max(500, input.max_chars ?? max)))
      const tail = end < text.length ? `is_truncated: true, next_start: ${String(end)}` : 'is_truncated: false (end of text)'
      const hint = start === 0 && end < text.length && sections.length > 0 && !scope ? ' The paper has sections: outline=true lists them.' : ''
      return { text: `${head}${scope}\nCharacters ${String(start)}–${String(end)}; ${tail}.${hint}\n${untrusted(text.slice(start, end))}` }
    },
    presentCall: args => ({ card: 'generic', title: (args as { outline?: boolean }).outline ? '查看论文目录' : '阅读论文全文', kind: 'read' }),
  }))

  const CITE_FORMATS: Record<string, string> = { bibtex: 'application/x-bibtex', ris: 'application/x-research-info-systems', csljson: 'application/vnd.citationstyles.csl+json' }

  tools.push(defineTool({
    name: 'paper_cite',
    description: 'Get the exact citation of papers from the DOI registries: BibTeX, RIS, CSL JSON, or a formatted reference in a citation style. Always use this (or zotero_export for papers in the user\'s library) instead of writing a reference or a BibTeX entry from memory.',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'string' }, description: 'DOIs, arXiv ids or PMIDs (up to 30).' },
      format: { type: 'string', required: true, enum: ['bibtex', 'ris', 'csljson', 'text'], description: 'text = a formatted reference in style.' },
      style: { type: 'string', description: 'CSL style id for format=text, e.g. apa, ieee, nature, chicago-author-date, china-national-standard-gb-t-7714-2015-numeric. Default from settings.' },
      locale: { type: 'string', description: 'Language of the style terms for format=text, e.g. en-US, zh-CN.' },
    },
    output,
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { ids: string[]; format: string; style?: string; locale?: string }
      const reach = reachOf(exec.signal)
      const style = input.style?.trim() || host.settings().citationStyle
      const accept = input.format === 'text' ? `text/x-bibliography; style=${style}${input.locale ? `; locale=${input.locale}` : ''}` : CITE_FORMATS[input.format]!
      const entries: string[] = []
      const problems: string[] = []
      for (const raw of input.ids.slice(0, 30)) {
        const id = parsePaperId(raw)
        let doi = id?.kind === 'doi' ? id.id : id?.kind === 'arxiv' ? `10.48550/arXiv.${id.id}` : undefined
        try {
          if (doi === undefined && (id?.kind === 'pmid' || id?.kind === 'pmcid')) doi = (await epmcRecord(id.kind === 'pmid' ? { pmid: id.id } : { pmcid: id.id }, reach))?.doi
          if (doi === undefined) { problems.push(`${raw}: no DOI known for it, so no registry citation. Use paper_get and build the reference from its fields.`); continue }
          const text = (await reach.http.text(`https://doi.org/${encodeURI(doi)}`, { headers: { accept }, signal: exec.signal, retries: 1 })).trim()
          entries.push(input.format === 'bibtex' ? text.replace(/^\s+@/, '@') : text)
        } catch (error) {
          if (exec.signal.aborted) throw error
          problems.push(`${raw}: ${(error as { status?: number }).status === 404 ? 'this DOI does not exist' : why(error)}`)
        }
      }
      const label = input.format === 'text' ? `style ${style}` : input.format
      return { text: [`Citations from the DOI registries (${label}): ${String(entries.length)} of ${String(Math.min(30, input.ids.length))}.`, entries.join(input.format === 'text' ? '\n' : '\n\n'), problems.length > 0 ? `Not cited:\n${problems.join('\n')}` : ''].filter(Boolean).join('\n') }
    },
    presentCall: args => ({ card: 'generic', title: `获取引文 ${String((args as { format?: string }).format ?? '')}`, kind: 'read' }),
  }))

  tools.push(defineTool({
    name: 'reference_verify',
    description: 'Check that references exist and are described correctly, against Crossref and the DOI registries (and, for the few that no index knows, CNKI for references in Chinese or Google Scholar, through a browser window): a DOI that does not exist or belongs to another work, a wrong title, first author or year, and retracted papers. Run it on any reference list before handing it to the user, including one you wrote yourself.',
    parameters: {
      references: { type: 'array', required: true, items: { type: 'string' }, description: 'One reference per entry, as written (authors, year, title, venue, DOI if any). Up to 40.' },
    },
    output,
    isConcurrencySafe: () => true,
    timeoutMs: 300_000,
    async execute(args, exec): Promise<Value> {
      const references = (args as { references: string[] }).references.map(reference => reference.trim()).filter(Boolean).slice(0, 40)
      if (references.length === 0) throw new Error('references is empty.')
      const reach = reachOf(exec.signal)
      const lines: string[] = []
      const counts = { verified: 0, check: 0, not_found: 0, failed: 0 }
      // Each lookup in the browser takes several seconds; a long list gets only so many.
      const budget = { browser: 8 }
      for (const [index, reference] of references.entries()) {
        try {
          const checked = await verifyReference(reference, reach, budget)
          counts[checked.verdict]++
          lines.push(formatChecked(checked, index + 1))
        } catch (error) {
          if (exec.signal.aborted) throw error
          counts.failed++
          lines.push(`[${String(index + 1)}] COULD NOT CHECK — ${reference.slice(0, 160)}\n    ! ${why(error)}`)
        }
      }
      const summary = `${String(counts.verified)} verified, ${String(counts.check)} to check, ${String(counts.not_found)} not found${counts.failed > 0 ? `, ${String(counts.failed)} could not be checked` : ''} (of ${String(references.length)}).`
      return { text: `${summary}\nVERIFIED = a record with this title, first author and year exists. CHECK = found, but something differs. NOT FOUND = no such DOI or no record with this title; do not present it as a real reference without finding it first.\n${untrusted(lines.join('\n'))}` }
    },
    presentCall: args => ({ card: 'generic', title: `核验参考文献：${String(((args as { references?: string[] }).references ?? []).length)} 条`, kind: 'search' }),
  }))

  tools.push(defineTool({
    name: 'paper_download',
    description: 'Save the open-access PDF of a paper into the workspace (folder papers/). Only for papers that are openly available; it does not get around paywalls.',
    parameters: {
      id: { type: 'string', required: true, description: 'arXiv id, DOI, PMID or PMCID.' },
      filename: { type: 'string', description: 'File name without folder. Default: from the id.' },
    },
    output,
    timeoutMs: 180_000,
    async execute(args, exec): Promise<Value> {
      const input = args as { id: string; filename?: string }
      const id = parsePaperId(input.id)
      if (id === undefined || id.kind === 'url') throw new Error('Give an arXiv id, a DOI, a PMID or a PMCID.')
      const cwd = (exec as unknown as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd
      if (!cwd) throw new Error('This conversation has no workspace folder to save into.')
      const reach = reachOf(exec.signal)
      const paper = await lookup(id, input.id, reach)
      const urls = [id.kind === 'arxiv' ? `https://arxiv.org/pdf/${id.id}` : undefined, paper?.arxiv === undefined ? undefined : `https://arxiv.org/pdf/${paper.arxiv}`, paper?.pdfUrl].filter((url): url is string => url !== undefined && isPublicUrl(url))
      let data: Uint8Array | undefined
      let from = ''
      for (const url of [...new Set(urls)]) {
        try {
          const bytes = await reach.http.bytes(url, { signal: exec.signal, timeoutMs: 90_000, maxBytes: 60 * 1_048_576, retries: 0, headers: { accept: 'application/pdf,*/*' } })
          if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) { data = bytes; from = url; break }
        } catch (error) {
          if (exec.signal.aborted) throw error
        }
      }
      if (data === undefined) throw new Error(`No open-access PDF could be downloaded for ${input.id}${urls.length === 0 ? ' (no index lists a free copy)' : ''}. The paper is probably behind a paywall.`)
      const base = (input.filename?.trim() || `${id.id}${paper?.title ? `-${paper.title}` : ''}`).replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, 90) || 'paper'
      const root = await realpath(cwd)
      const dir = join(root, 'papers')
      const target = resolve(dir, `${base}.pdf`)
      if (!target.startsWith(dir + sep)) throw new Error('filename must be a plain file name.')
      await mkdir(dir, { recursive: true })
      await writeFile(target, data)
      return { text: `Saved ${String(Math.round(data.byteLength / 1024))} KB to ${relative(root, target).split(sep).join('/')} (from ${from}).${paper?.title ? ` "${paper.title}"` : ''}` }
    },
    presentCall: () => ({ card: 'generic', title: '下载开放获取 PDF', kind: 'fetch' }),
  }))

  return tools
}
