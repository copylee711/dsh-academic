/**
 * One shape for a paper whatever index it came from, and the merge that
 * turns the same paper found in several indexes into one record.
 */
import { arxivId } from '../sources/arxiv.js'

export interface Paper {
  title: string
  authors: string[]
  year?: number
  /** ISO date when the index knows more than the year. */
  date?: string
  venue?: string
  abstract?: string
  /** One-sentence summary (Semantic Scholar). */
  tldr?: string
  type?: string
  doi?: string
  arxiv?: string
  pmid?: string
  pmcid?: string
  openalex?: string
  s2?: string
  url?: string
  /** A lawful open-access copy. */
  pdfUrl?: string
  citations?: number
  openAccess?: boolean
  retracted?: boolean
  /** The indexes that returned it. */
  sources: string[]
}

export const SOURCE_IDS = ['arxiv', 'openalex', 'crossref', 'semanticscholar', 'pubmed', 'europepmc', 'dblp'] as const
export type SourceId = typeof SOURCE_IDS[number]

export const SOURCE_NAMES: Record<SourceId, string> = {
  arxiv: 'arXiv', openalex: 'OpenAlex', crossref: 'Crossref', semanticscholar: 'Semantic Scholar', pubmed: 'PubMed', europepmc: 'Europe PMC', dblp: 'DBLP',
}

export function cleanDoi(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const doi = value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined
}

/** Markup and entities out of a title or an abstract. */
export function plain(value: unknown): string {
  return typeof value !== 'string' ? '' : value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, '\'')
    .replace(/\s+/g, ' ').trim()
}

export function titleKey(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Fill in what each record knows about itself from its ids. */
export function normalize(paper: Paper): Paper {
  const out = { ...paper }
  // An arXiv DOI and an arXiv id name the same thing.
  if (out.arxiv === undefined && out.doi !== undefined) { const id = /^10\.48550\/arxiv\.(.+)$/i.exec(out.doi)?.[1]; if (id !== undefined) out.arxiv = arxivId(id) ?? id }
  if (out.doi === undefined && out.arxiv !== undefined) out.doi = `10.48550/arXiv.${out.arxiv}`
  if (out.pdfUrl === undefined && out.arxiv !== undefined) out.pdfUrl = `https://arxiv.org/pdf/${out.arxiv}`
  if (out.url === undefined) {
    const url = out.arxiv !== undefined && /^10\.48550\//i.test(out.doi ?? '') ? `https://arxiv.org/abs/${out.arxiv}` : out.doi !== undefined ? `https://doi.org/${out.doi}` : out.pmid !== undefined ? `https://pubmed.ncbi.nlm.nih.gov/${out.pmid}/` : undefined
    if (url !== undefined) out.url = url
  }
  if (out.year === undefined && out.date !== undefined) { const year = Number(out.date.slice(0, 4)); if (Number.isFinite(year) && year > 1000) out.year = year }
  return out
}

function keysOf(paper: Paper): string[] {
  const keys: string[] = []
  // A published version carries its own DOI; the arXiv id still ties it to the preprint.
  if (paper.arxiv) keys.push(`arxiv:${paper.arxiv.toLowerCase()}`)
  if (paper.doi) keys.push(`doi:${paper.doi.toLowerCase()}`)
  if (paper.pmid) keys.push(`pmid:${paper.pmid}`)
  const title = titleKey(paper.title)
  if (title.length >= 20) keys.push(`title:${title}`)
  return keys
}

function mergeInto(target: Paper, other: Paper): void {
  const longer = (a: string | undefined, b: string | undefined): string | undefined => (b !== undefined && b.length > (a?.length ?? 0) ? b : a)
  const fill = <K extends keyof Paper>(key: K): void => { if (target[key] === undefined && other[key] !== undefined) target[key] = other[key] }
  for (const key of ['year', 'date', 'venue', 'tldr', 'type', 'arxiv', 'pmid', 'pmcid', 'openalex', 's2', 'url', 'pdfUrl'] as const) fill(key)
  // The DOI of the published version wins over the preprint's.
  if (other.doi !== undefined && (target.doi === undefined || (/^10\.48550\//i.test(target.doi) && !/^10\.48550\//i.test(other.doi)))) target.doi = other.doi
  const abstract = longer(target.abstract, other.abstract)
  if (abstract !== undefined) target.abstract = abstract
  if (other.authors.length > target.authors.length) target.authors = other.authors
  if (other.citations !== undefined) target.citations = Math.max(target.citations ?? 0, other.citations)
  if (other.openAccess === true || (target.openAccess === undefined && other.openAccess !== undefined)) target.openAccess = other.openAccess
  if (other.retracted === true) target.retracted = true
  for (const source of other.sources) if (!target.sources.includes(source)) target.sources.push(source)
}

/**
 * Merge ranked lists into one. A paper found by several indexes is one
 * record; order is by reciprocal rank fusion, so a paper every index puts
 * near the top comes first.
 */
export function mergeRanked(lists: ReadonlyArray<readonly Paper[]>): Paper[] {
  const merged: Array<{ paper: Paper; score: number }> = []
  const index = new Map<string, { paper: Paper; score: number }>()
  for (const list of lists) {
    list.forEach((raw, rank) => {
      const paper = normalize(raw)
      const keys = keysOf(paper)
      let entry = keys.map(key => index.get(key)).find(found => found !== undefined)
      if (entry === undefined) { entry = { paper: { ...paper, sources: [...paper.sources] }, score: 0 }; merged.push(entry) } else mergeInto(entry.paper, paper)
      entry.score += 1 / (60 + rank)
      for (const key of [...keys, ...keysOf(entry.paper)]) if (!index.has(key)) index.set(key, entry)
    })
  }
  return merged.sort((a, b) => b.score - a.score).map(entry => entry.paper)
}

export function authorLine(authors: readonly string[], max = 4): string {
  return authors.length <= max ? authors.join(', ') : `${authors.slice(0, max - 1).join(', ')}, … ${authors.at(-1)!} (${String(authors.length)} authors)`
}

/** The id to pass back to the paper_ tools: arXiv first, then DOI, PubMed. */
export function bestId(paper: Paper): string {
  // Every paper_ tool takes an arXiv id, and arXiv is where the text reads best.
  if (paper.arxiv !== undefined) return `arXiv:${paper.arxiv}`
  return paper.doi ?? (paper.pmid !== undefined ? `PMID:${paper.pmid}` : paper.openalex ?? paper.s2 ?? paper.url ?? paper.title)
}

export function formatPaper(paper: Paper, index: number, abstractChars: number): string {
  const facts = [authorLine(paper.authors), paper.year === undefined ? '' : String(paper.year), paper.venue ?? ''].filter(Boolean).join(' · ')
  const marks = [
    `id: ${bestId(paper)}`,
    paper.citations === undefined ? '' : `cited ${String(paper.citations)}`,
    paper.pdfUrl !== undefined || paper.openAccess === true ? 'open access' : '',
    paper.retracted === true ? 'RETRACTED' : '',
    `via ${paper.sources.join(', ')}`,
  ].filter(Boolean).join(' · ')
  const abstract = paper.tldr && abstractChars > 0 && abstractChars < 400 ? paper.tldr : paper.abstract ?? ''
  return [
    `[${String(index)}] ${paper.title}`,
    facts ? `    ${facts}` : '',
    `    ${marks}`,
    paper.url ? `    ${paper.url}` : '',
    abstractChars > 0 && abstract ? `    ${abstract.length > abstractChars ? `${abstract.slice(0, abstractChars).trimEnd()}…` : abstract}` : '',
  ].filter(Boolean).join('\n')
}

export function formatPaperDetail(paper: Paper): string {
  return [
    paper.title,
    paper.retracted === true ? 'RETRACTED: this paper has been retracted.' : '',
    paper.authors.length > 0 ? `authors: ${paper.authors.join(', ')}` : '',
    paper.date ?? paper.year ? `date: ${paper.date ?? String(paper.year)}` : '',
    paper.venue ? `venue: ${paper.venue}` : '',
    paper.type ? `type: ${paper.type}` : '',
    paper.doi ? `DOI: ${paper.doi}` : '',
    paper.arxiv ? `arXiv: ${paper.arxiv}` : '',
    paper.pmid ? `PMID: ${paper.pmid}` : '',
    paper.pmcid ? `PMCID: ${paper.pmcid}` : '',
    paper.citations === undefined ? '' : `cited by: ${String(paper.citations)}`,
    paper.url ? `url: ${paper.url}` : '',
    paper.pdfUrl ? `open-access PDF: ${paper.pdfUrl}` : paper.openAccess === true ? 'open access: yes' : '',
    `found in: ${paper.sources.join(', ')}`,
    paper.tldr ? `\nsummary (Semantic Scholar): ${paper.tldr}` : '',
    paper.abstract ? `\nabstract:\n${paper.abstract}` : '\n(no abstract in the indexes asked)',
  ].filter(Boolean).join('\n')
}
