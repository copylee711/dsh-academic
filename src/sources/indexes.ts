/**
 * The scholarly indexes behind paper_search: each turns the common query into
 * its own API call and its answer into Paper records. All of them work
 * without a key; a contact e-mail or a key only raises their limits.
 */
import { XMLParser } from 'fast-xml-parser'
import type { Http } from '../net/http.js'
import { cleanDoi, plain, type Paper, type SourceId } from '../search/paper.js'
import { arxivId, parseArxivAtom, type ArxivPaper } from './arxiv.js'

export interface Query {
  query: string
  limit: number
  yearFrom?: number
  yearTo?: number
  openAccess?: boolean
  sort: 'relevance' | 'date' | 'citations'
  /** arXiv categories such as cs.LG; other indexes ignore them. */
  categories?: string[]
}

export interface Keys {
  email?: string
  s2Key?: string
  openalexKey?: string
  ncbiKey?: string
}

export interface Reach { http: Http; keys: Keys; signal?: AbortSignal | undefined }

const params = (values: Record<string, string | number | undefined>): string =>
  Object.entries(values).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '').map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')

const year = (value: unknown): number | undefined => { const n = Number(String(value ?? '').slice(0, 4)); return Number.isFinite(n) && n > 1000 ? n : undefined }

/** A Paper without the fields an index left empty. */
const defined = (value: { [K in keyof Paper]: Paper[K] | undefined }): Paper => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined && field !== '')) as unknown as Paper

// ---------------------------------------------------------------- arXiv

export function paperFromArxiv(entry: ArxivPaper): Paper {
  return defined({
    title: entry.title, authors: entry.authors, date: entry.published.slice(0, 10), year: year(entry.published), abstract: entry.abstract,
    venue: entry.journalRef ?? 'arXiv', type: 'preprint', arxiv: entry.id, doi: entry.doi, url: `https://arxiv.org/abs/${entry.id}`,
    pdfUrl: `https://arxiv.org/pdf/${entry.id}`, openAccess: true, sources: ['arXiv'],
  })
}

const ARXIV_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'in', 'on', 'and', 'or', 'to', 'with', 'is', 'are', 'via', 'using', 'by', 'from', 'at', 'as'])

/**
 * arXiv's `search_query`: plain words are looked for in titles and abstracts,
 * since `all:` also matches fragments of author names. `anyWord` is the
 * looser form, for when requiring every word finds nothing.
 */
export function arxivSearchQuery(query: Query, anyWord = false): string {
  const text = query.query.trim()
  const fielded = /\b(ti|au|abs|cat|co|jr|rn|all|id):/.test(text)
  // Every word (or quoted phrase) must be in the title or the abstract; left alone, arXiv ORs them.
  const terms = (text.match(/"[^"]+"|[^\s"]+/g) ?? []).filter(term => !ARXIV_STOPWORDS.has(term.toLowerCase()))
  const words = (anyWord ? [] : terms).map(term => `(ti:${term} OR abs:${term})`).join(' AND ')
  const parts = [fielded ? `(${text})` : words !== '' ? `(${words})` : `(ti:(${text}) OR abs:(${text}))`]
  if ((query.categories?.length ?? 0) > 0) parts.push(`(${query.categories!.map(category => `cat:${category}`).join(' OR ')})`)
  if (query.yearFrom !== undefined || query.yearTo !== undefined) parts.push(`submittedDate:[${String(query.yearFrom ?? 1991)}01010000 TO ${String(query.yearTo ?? 2100)}12312359]`)
  return parts.join(' AND ')
}

async function arxiv(query: Query, reach: Reach): Promise<Paper[]> {
  const ask = async (anyWord: boolean): Promise<Paper[]> => {
    const url = `https://export.arxiv.org/api/query?${params({ search_query: arxivSearchQuery(query, anyWord), start: 0, max_results: query.limit, sortBy: query.sort === 'date' ? 'submittedDate' : 'relevance', sortOrder: 'descending' })}`
    // 406 is arXiv throttling this address: asking again only prolongs it.
    return parseArxivAtom(await reach.http.text(url, { signal: reach.signal, timeoutMs: 30_000, retries: 1 })).map(paperFromArxiv)
  }
  const strict = await ask(false)
  // A long question rarely has all its words in one abstract; ranked by relevance, any of them will do.
  return strict.length > 0 || query.sort === 'date' ? strict : await ask(true)
}

// ---------------------------------------------------------------- OpenAlex

interface OpenAlexWork {
  id?: string; doi?: string | null; display_name?: string | null; publication_year?: number; publication_date?: string; type?: string
  authorships?: Array<{ author?: { display_name?: string } }>
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string | null } | null
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null
  open_access?: { is_oa?: boolean; oa_url?: string | null }
  cited_by_count?: number; is_retracted?: boolean
  abstract_inverted_index?: Record<string, number[]> | null
  ids?: { pmid?: string; pmcid?: string }
}

const OPENALEX_FIELDS = 'id,doi,display_name,publication_year,publication_date,type,authorships,primary_location,best_oa_location,open_access,cited_by_count,is_retracted,abstract_inverted_index,ids'

/** OpenAlex stores an abstract as word -> positions. */
export function invertedAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined
  const words: string[] = []
  for (const [word, positions] of Object.entries(index)) for (const position of positions) words[position] = word
  const text = words.filter(word => word !== undefined).join(' ').trim()
  return text === '' ? undefined : text
}

export function paperFromOpenAlex(work: OpenAlexWork): Paper {
  const doi = cleanDoi(work.doi ?? undefined)
  const arxiv = doi === undefined ? arxivId(work.primary_location?.landing_page_url ?? '') : undefined
  return defined({
    title: plain(work.display_name ?? ''), authors: (work.authorships ?? []).map(entry => entry.author?.display_name ?? '').filter(Boolean),
    year: work.publication_year, date: work.publication_date, venue: work.primary_location?.source?.display_name ?? undefined, type: work.type,
    abstract: invertedAbstract(work.abstract_inverted_index), doi, arxiv,
    pmid: work.ids?.pmid?.replace(/^.*\//, ''), pmcid: work.ids?.pmcid?.replace(/^.*\//, ''),
    openalex: work.id?.replace(/^.*\//, ''), url: doi === undefined ? work.primary_location?.landing_page_url ?? undefined : undefined,
    pdfUrl: work.best_oa_location?.pdf_url ?? undefined, openAccess: work.open_access?.is_oa, citations: work.cited_by_count,
    retracted: work.is_retracted === true ? true : undefined, sources: ['OpenAlex'],
  })
}

function openalexUrl(path: string, values: Record<string, string | number | undefined>, keys: Keys): string {
  return `https://api.openalex.org/${path}?${params({ ...values, select: OPENALEX_FIELDS, mailto: keys.email, api_key: keys.openalexKey })}`
}

async function openalex(query: Query, reach: Reach): Promise<Paper[]> {
  const filters = [
    query.yearFrom !== undefined || query.yearTo !== undefined ? `publication_year:${String(query.yearFrom ?? '')}-${String(query.yearTo ?? '')}` : '',
    query.openAccess === true ? 'open_access.is_oa:true' : '',
  ].filter(Boolean).join(',')
  const url = openalexUrl('works', { search: query.query, filter: filters, 'per-page': query.limit, sort: query.sort === 'date' ? 'publication_date:desc' : query.sort === 'citations' ? 'cited_by_count:desc' : undefined }, reach.keys)
  return ((await reach.http.json<{ results?: OpenAlexWork[] }>(url, { signal: reach.signal })).results ?? []).map(paperFromOpenAlex).filter(paper => paper.title !== '')
}

/** One work by DOI, PMID or OpenAlex id; undefined when OpenAlex does not have it. */
export async function openalexWork(id: string, reach: Reach): Promise<Paper | undefined> {
  try {
    return paperFromOpenAlex(await reach.http.json<OpenAlexWork>(openalexUrl(`works/${id}`, {}, reach.keys), { signal: reach.signal }))
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined
    throw error
  }
}

/** Works that cite, are cited by, or are related to an OpenAlex work. */
export async function openalexLinked(openalexId: string, relation: 'cites' | 'cited_by' | 'related_to', limit: number, reach: Reach): Promise<{ papers: Paper[]; total?: number }> {
  const body = await reach.http.json<{ results?: OpenAlexWork[]; meta?: { count?: number } }>(openalexUrl('works', { filter: `${relation}:${openalexId}`, 'per-page': limit, sort: relation === 'related_to' ? undefined : 'cited_by_count:desc' }, reach.keys), { signal: reach.signal })
  return { papers: (body.results ?? []).map(paperFromOpenAlex).filter(paper => paper.title !== ''), ...(body.meta?.count === undefined ? {} : { total: body.meta.count }) }
}

// ---------------------------------------------------------------- Crossref

export interface CrossrefWork {
  DOI?: string; title?: string[]; author?: Array<{ given?: string; family?: string; name?: string }>
  issued?: { 'date-parts'?: Array<Array<number | null>> }; 'container-title'?: string[]; abstract?: string; type?: string
  'is-referenced-by-count'?: number; URL?: string
  'update-to'?: Array<{ type?: string; DOI?: string }>
  relation?: Record<string, unknown>
}

export function paperFromCrossref(work: CrossrefWork): Paper {
  const parts = work.issued?.['date-parts']?.[0]?.filter((part): part is number => typeof part === 'number') ?? []
  return defined({
    title: plain(work.title?.[0] ?? ''), authors: (work.author ?? []).map(author => author.name ?? [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean),
    year: parts[0], date: parts.length > 1 ? parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-') : undefined,
    venue: plain(work['container-title']?.[0] ?? '') || undefined, abstract: plain(work.abstract ?? '') || undefined, type: work.type,
    doi: cleanDoi(work.DOI), citations: work['is-referenced-by-count'], sources: ['Crossref'],
  })
}

const crossrefHeaders = (keys: Keys): Record<string, string> => (keys.email ? { 'user-agent': `dsh-academic (mailto:${keys.email})` } : {})

async function crossref(query: Query, reach: Reach): Promise<Paper[]> {
  const filters = [query.yearFrom === undefined ? '' : `from-pub-date:${String(query.yearFrom)}`, query.yearTo === undefined ? '' : `until-pub-date:${String(query.yearTo)}`].filter(Boolean).join(',')
  const url = `https://api.crossref.org/works?${params({ 'query.bibliographic': query.query, rows: query.limit, filter: filters, select: 'DOI,title,author,issued,container-title,abstract,type,is-referenced-by-count', sort: query.sort === 'date' ? 'published' : query.sort === 'citations' ? 'is-referenced-by-count' : undefined, mailto: reach.keys.email })}`
  return ((await reach.http.json<{ message?: { items?: CrossrefWork[] } }>(url, { signal: reach.signal, headers: crossrefHeaders(reach.keys), timeoutMs: 30_000 })).message?.items ?? []).map(paperFromCrossref).filter(paper => paper.title !== '')
}

/** The Crossref record of a DOI; undefined when Crossref did not register it. */
export async function crossrefWork(doi: string, reach: Reach): Promise<CrossrefWork | undefined> {
  try {
    return (await reach.http.json<{ message?: CrossrefWork }>(`https://api.crossref.org/works/${encodeURIComponent(doi)}${reach.keys.email ? `?mailto=${encodeURIComponent(reach.keys.email)}` : ''}`, { signal: reach.signal, headers: crossrefHeaders(reach.keys) })).message
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined
    throw error
  }
}

/** The closest Crossref records to a free-text reference. */
export async function crossrefMatch(reference: string, rows: number, reach: Reach): Promise<CrossrefWork[]> {
  const url = `https://api.crossref.org/works?${params({ 'query.bibliographic': reference.slice(0, 600), rows, select: 'DOI,title,author,issued,container-title,type,update-to', mailto: reach.keys.email })}`
  return (await reach.http.json<{ message?: { items?: CrossrefWork[] } }>(url, { signal: reach.signal, headers: crossrefHeaders(reach.keys), timeoutMs: 30_000 })).message?.items ?? []
}

// ---------------------------------------------------------------- Semantic Scholar

interface S2Paper {
  paperId?: string; title?: string; year?: number; venue?: string; abstract?: string | null; publicationDate?: string | null
  authors?: Array<{ name?: string }>; citationCount?: number
  externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string; PubMedCentral?: string } | null
  openAccessPdf?: { url?: string } | null; tldr?: { text?: string } | null
}

const S2_FIELDS = 'title,year,venue,abstract,publicationDate,authors,citationCount,externalIds,openAccessPdf,tldr'

export function paperFromS2(paper: S2Paper): Paper {
  return defined({
    title: plain(paper.title ?? ''), authors: (paper.authors ?? []).map(author => author.name ?? '').filter(Boolean), year: paper.year ?? undefined,
    date: paper.publicationDate ?? undefined, venue: paper.venue || undefined, abstract: paper.abstract ?? undefined, tldr: paper.tldr?.text ?? undefined,
    doi: cleanDoi(paper.externalIds?.DOI), arxiv: paper.externalIds?.ArXiv, pmid: paper.externalIds?.PubMed,
    pmcid: paper.externalIds?.PubMedCentral === undefined ? undefined : `PMC${paper.externalIds.PubMedCentral}`,
    s2: paper.paperId, pdfUrl: paper.openAccessPdf?.url || undefined, citations: paper.citationCount, sources: ['Semantic Scholar'],
  })
}

const s2Headers = (keys: Keys): Record<string, string> => (keys.s2Key ? { 'x-api-key': keys.s2Key } : {})

async function semanticscholar(query: Query, reach: Reach): Promise<Paper[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params({ query: query.query, limit: query.limit, fields: S2_FIELDS, year: query.yearFrom !== undefined || query.yearTo !== undefined ? `${String(query.yearFrom ?? '')}-${String(query.yearTo ?? '')}` : undefined })}${query.openAccess === true ? '&openAccessPdf' : ''}`
  // Without a key the pool is shared by everyone: one try, no waiting.
  return ((await reach.http.json<{ data?: S2Paper[] }>(url, { signal: reach.signal, headers: s2Headers(reach.keys), retries: reach.keys.s2Key ? 2 : 0 })).data ?? []).map(paperFromS2).filter(paper => paper.title !== '')
}

/** One paper by `DOI:…`, `ARXIV:…`, `PMID:…` or S2 id; undefined when unknown or the shared pool is busy. */
export async function s2Paper(id: string, reach: Reach): Promise<Paper | undefined> {
  try {
    return paperFromS2(await reach.http.json<S2Paper>(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`, { signal: reach.signal, headers: s2Headers(reach.keys), retries: reach.keys.s2Key ? 2 : 0 }))
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 404 || status === 429 || status === 400) return undefined
    throw error
  }
}

// ---------------------------------------------------------------- Europe PMC

interface EpmcResult {
  id?: string; source?: string; pmid?: string; pmcid?: string; doi?: string; title?: string; authorString?: string; pubYear?: string
  firstPublicationDate?: string; abstractText?: string; citedByCount?: number; isOpenAccess?: string; pubType?: string
  journalInfo?: { journal?: { title?: string } }; bookOrReportDetails?: { publisher?: string }
  fullTextUrlList?: { fullTextUrl?: Array<{ documentStyle?: string; availabilityCode?: string; url?: string }> }
}

export function paperFromEpmc(result: EpmcResult): Paper {
  const pdf = result.fullTextUrlList?.fullTextUrl?.find(entry => entry.documentStyle === 'pdf' && (entry.availabilityCode === 'OA' || entry.availabilityCode === 'F'))?.url
  return defined({
    title: plain(result.title ?? '').replace(/\.$/, ''), authors: (result.authorString ?? '').replace(/\.$/, '').split(', ').filter(Boolean),
    year: year(result.pubYear), date: result.firstPublicationDate, venue: result.journalInfo?.journal?.title ?? (result.source === 'PPR' ? result.bookOrReportDetails?.publisher : undefined),
    abstract: plain(result.abstractText ?? '') || undefined, type: result.source === 'PPR' ? 'preprint' : undefined,
    doi: cleanDoi(result.doi), pmid: result.pmid, pmcid: result.pmcid, pdfUrl: pdf, openAccess: result.isOpenAccess === 'Y' ? true : undefined,
    citations: result.citedByCount, sources: ['Europe PMC'],
  })
}

async function epmcSearch(expression: string, limit: number, sort: Query['sort'], reach: Reach): Promise<Paper[]> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params({ query: expression, format: 'json', resultType: 'core', pageSize: limit, sort: sort === 'date' ? 'P_PDATE_D desc' : undefined, email: reach.keys.email })}`
  return ((await reach.http.json<{ resultList?: { result?: EpmcResult[] } }>(url, { signal: reach.signal, timeoutMs: 30_000 })).resultList?.result ?? []).map(paperFromEpmc).filter(paper => paper.title !== '')
}

async function europepmc(query: Query, reach: Reach): Promise<Paper[]> {
  const clauses = [
    query.query,
    query.yearFrom !== undefined || query.yearTo !== undefined ? `PUB_YEAR:[${String(query.yearFrom ?? 1800)} TO ${String(query.yearTo ?? 2100)}]` : '',
    query.openAccess === true ? 'OPEN_ACCESS:y' : '',
  ].filter(Boolean)
  return await epmcSearch(clauses.length === 1 ? clauses[0]! : clauses.map((clause, index) => (index === 0 ? `(${clause})` : clause)).join(' AND '), query.limit, query.sort, reach)
}

/** One record by DOI, PMID or PMCID. */
export async function epmcRecord(id: { doi?: string; pmid?: string; pmcid?: string }, reach: Reach): Promise<Paper | undefined> {
  const expression = id.pmcid !== undefined ? `PMCID:${id.pmcid}` : id.pmid !== undefined ? `EXT_ID:${id.pmid} AND SRC:MED` : id.doi !== undefined ? `DOI:"${id.doi}"` : undefined
  return expression === undefined ? undefined : (await epmcSearch(expression, 1, 'relevance', reach))[0]
}

/** The JATS XML of an open-access article in PMC; undefined when Europe PMC has no full text for it. */
export async function epmcFullTextXml(pmcid: string, reach: Reach): Promise<string | undefined> {
  try {
    return await reach.http.text(`https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(pmcid)}/fullTextXML`, { signal: reach.signal, timeoutMs: 40_000 })
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined
    throw error
  }
}

// ---------------------------------------------------------------- PubMed

const pubmedParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', stopNodes: ['*.ArticleTitle', '*.AbstractText'],
  isArray: name => ['PubmedArticle', 'Author', 'AbstractText', 'ArticleId'].includes(name),
})

const raw = (value: unknown): string => plain(typeof value === 'object' && value !== null ? String((value as { '#text'?: unknown })['#text'] ?? '') : String(value ?? ''))

export function parsePubmedXml(xml: string): Paper[] {
  const set = (pubmedParser.parse(xml) as { PubmedArticleSet?: { PubmedArticle?: Array<Record<string, any>> } }).PubmedArticleSet
  return (set?.PubmedArticle ?? []).map(entry => {
    const citation = entry.MedlineCitation ?? {}
    const article = citation.Article ?? {}
    const ids = (entry.PubmedData?.ArticleIdList?.ArticleId ?? []) as Array<{ '@IdType'?: string; '#text'?: unknown }>
    const idOf = (kind: string): string | undefined => { const found = ids.find(id => id['@IdType'] === kind)?.['#text']; return found === undefined ? undefined : String(found) }
    const abstract = ((article.Abstract?.AbstractText ?? []) as unknown[]).map(part => {
      const label = typeof part === 'object' && part !== null ? (part as { '@Label'?: string })['@Label'] : undefined
      return `${label ? `${label}: ` : ''}${raw(part)}`
    }).filter(Boolean).join(' ')
    const pubDate = article.Journal?.JournalIssue?.PubDate ?? {}
    return defined({
      title: raw(article.ArticleTitle).replace(/\.$/, ''),
      authors: ((article.AuthorList?.Author ?? []) as Array<{ LastName?: string; ForeName?: string; CollectiveName?: string }>).map(author => author.CollectiveName ?? [author.ForeName, author.LastName].filter(Boolean).join(' ')).filter(Boolean),
      year: year(pubDate.Year ?? pubDate.MedlineDate), venue: typeof article.Journal?.Title === 'string' ? article.Journal.Title : undefined,
      abstract: abstract || undefined, doi: cleanDoi(idOf('doi')), pmid: raw(citation.PMID) || idOf('pubmed'), pmcid: idOf('pmc'), sources: ['PubMed'],
    })
  }).filter(paper => paper.title !== '')
}

async function pubmed(query: Query, reach: Reach): Promise<Paper[]> {
  const common = { tool: 'dsh-academic', email: reach.keys.email, api_key: reach.keys.ncbiKey }
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
  const term = [query.query, query.yearFrom !== undefined || query.yearTo !== undefined ? `${String(query.yearFrom ?? 1800)}:${String(query.yearTo ?? 3000)}[dp]` : '', query.openAccess === true ? 'free full text[sb]' : ''].filter(Boolean).map((part, index, all) => (all.length > 1 && index === 0 ? `(${part})` : part)).join(' AND ')
  const found = await reach.http.json<{ esearchresult?: { idlist?: string[] } }>(`${base}/esearch.fcgi?${params({ db: 'pubmed', term, retmax: query.limit, retmode: 'json', sort: query.sort === 'date' ? 'pub_date' : 'relevance', ...common })}`, { signal: reach.signal })
  const ids = found.esearchresult?.idlist ?? []
  if (ids.length === 0) return []
  const papers = parsePubmedXml(await reach.http.text(`${base}/efetch.fcgi?${params({ db: 'pubmed', id: ids.join(','), retmode: 'xml', ...common })}`, { signal: reach.signal, timeoutMs: 30_000 }))
  // efetch answers in id order of its own; keep the relevance order of the search.
  return ids.map(id => papers.find(paper => paper.pmid === id)).filter((paper): paper is Paper => paper !== undefined)
}

// ---------------------------------------------------------------- DBLP

interface DblpHit { info?: { title?: string; authors?: { author?: Array<{ text?: string }> | { text?: string } }; venue?: string | string[]; year?: string; doi?: string; ee?: string | string[]; type?: string; url?: string } }

export function paperFromDblp(hit: DblpHit): Paper {
  const info = hit.info ?? {}
  const authors = info.authors?.author === undefined ? [] : Array.isArray(info.authors.author) ? info.authors.author : [info.authors.author]
  const link = Array.isArray(info.ee) ? info.ee[0] : info.ee
  return defined({
    // DBLP numbers namesakes: "Wei Wang 0001".
    title: plain(info.title ?? '').replace(/\.$/, ''), authors: authors.map(author => (author.text ?? '').replace(/ \d{4}$/, '')).filter(Boolean),
    year: year(info.year), venue: Array.isArray(info.venue) ? info.venue[0] : info.venue, type: info.type, doi: cleanDoi(info.doi),
    arxiv: info.doi === undefined && link ? arxivId(link) : undefined, url: info.doi === undefined ? link ?? info.url : undefined, sources: ['DBLP'],
  })
}

async function dblp(query: Query, reach: Reach): Promise<Paper[]> {
  const words = [query.query, query.yearFrom !== undefined && query.yearFrom === query.yearTo ? `year:${String(query.yearFrom)}:` : ''].filter(Boolean).join(' ')
  const answer = await reach.http.text(`https://dblp.org/search/publ/api?${params({ q: words, format: 'json', h: Math.min(100, query.limit * 2) })}`, { signal: reach.signal, timeoutMs: 30_000 })
  // DBLP puts a browser check in front of its API on some networks.
  if (answer.trimStart().startsWith('<')) throw new Error('DBLP asked for a browser check instead of answering')
  const body = JSON.parse(answer) as { result?: { hits?: { hit?: DblpHit[] } } }
  return (body.result?.hits?.hit ?? []).map(paperFromDblp)
    .filter(paper => paper.title !== '' && (query.yearFrom === undefined || (paper.year ?? 0) >= query.yearFrom) && (query.yearTo === undefined || (paper.year ?? 9999) <= query.yearTo))
    .slice(0, query.limit)
}

export const SEARCHERS: Record<SourceId, (query: Query, reach: Reach) => Promise<Paper[]>> = { arxiv, openalex, crossref, semanticscholar, pubmed, europepmc, dblp }
