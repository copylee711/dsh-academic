/**
 * Get the text of a paper from where it is lawfully open: arXiv's HTML (then
 * ar5iv, then the PDF), PubMed Central's XML, or an open-access PDF that
 * Europe PMC, OpenAlex, Unpaywall or Semantic Scholar point to. Nothing
 * behind a paywall is fetched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanDoi, type Paper } from '../search/paper.js'
import { arxivId } from '../sources/arxiv.js'
import { epmcFullTextXml, epmcRecord, openalexWork, s2Paper, type Reach } from '../sources/indexes.js'
import { doiOf } from '../zotero/csl.js'
import { arxivHtmlToText, jatsToText } from './markup.js'

export type PaperId =
  | { kind: 'arxiv'; id: string }
  | { kind: 'doi'; id: string }
  | { kind: 'pmid'; id: string }
  | { kind: 'pmcid'; id: string }
  | { kind: 'url'; id: string }

/** Tell what kind of id the model passed; undefined for anything that is not an id. */
export function parsePaperId(input: string): PaperId | undefined {
  const text = input.trim()
  const arxiv = arxivId(text)
  if (arxiv !== undefined) return { kind: 'arxiv', id: arxiv }
  const pmc = /^(?:PMCID:\s*)?(PMC\d+)$/i.exec(text)?.[1] ?? /ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d+)/i.exec(text)?.[1] ?? /pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)/i.exec(text)?.[1]
  if (pmc !== undefined) return { kind: 'pmcid', id: pmc.toUpperCase() }
  const pmid = /^(?:PMID:\s*)?(\d{4,9})$/i.exec(text)?.[1] ?? /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(text)?.[1]
  if (pmid !== undefined) return { kind: 'pmid', id: pmid }
  const doi = cleanDoi(text) ?? doiOf(text)
  if (doi !== undefined) return { kind: 'doi', id: doi }
  if (/^https?:\/\/\S+$/i.test(text)) return { kind: 'url', id: text }
  return undefined
}

export interface FullText {
  text: string
  /** Where the text came from, in words for the model. */
  source: string
  /** Whether the text has headings to read by section. */
  structured: boolean
  url?: string
}

/** Only public web addresses are fetched: an index could name anything as a "PDF link". */
export function isPublicUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) return false
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false
    if (host.includes(':') && /^(::1|fe80:|fc|fd|::ffff:)/.test(host)) return false
    return true
  } catch {
    return false
  }
}

export interface Resolver {
  reach: Reach
  pdfText(data: Uint8Array): Promise<string>
}

const MAX_PDF = 40 * 1_048_576

async function pdfFrom(url: string, resolver: Resolver): Promise<string | undefined> {
  if (!isPublicUrl(url)) return undefined
  try {
    const data = await resolver.reach.http.bytes(url, { signal: resolver.reach.signal, timeoutMs: 60_000, maxBytes: MAX_PDF, retries: 0, headers: { accept: 'application/pdf,*/*' } })
    // A landing page or a login wall is not a PDF.
    if (!(data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) return undefined
    const text = await resolver.pdfText(data)
    return text.replace(/\[page \d+\]/g, '').trim().length < 500 ? undefined : text
  } catch (error) {
    if (resolver.reach.signal?.aborted) throw error
    return undefined
  }
}

async function page(url: string, resolver: Resolver): Promise<string | undefined> {
  try {
    return await resolver.reach.http.text(url, { signal: resolver.reach.signal, timeoutMs: 40_000, retries: 0 })
  } catch (error) {
    if (resolver.reach.signal?.aborted) throw error
    return undefined
  }
}

async function fromArxiv(id: string, resolver: Resolver): Promise<FullText | undefined> {
  for (const [url, name] of [[`https://arxiv.org/html/${id}`, 'arXiv\'s HTML version'], [`https://ar5iv.labs.arxiv.org/html/${id}`, 'ar5iv\'s HTML version']] as const) {
    const html = await page(url, resolver)
    const text = html === undefined ? undefined : arxivHtmlToText(html)
    if (text !== undefined) return { text, source: name, structured: true, url }
  }
  const url = `https://arxiv.org/pdf/${id}`
  const text = await pdfFrom(url, resolver)
  return text === undefined ? undefined : { text, source: 'the arXiv PDF', structured: false, url }
}

async function quiet<T>(work: Promise<T>, resolver: Resolver): Promise<T | undefined> {
  try { return await work } catch (error) { if (resolver.reach.signal?.aborted) throw error; return undefined }
}

/** Find and read the open text of a paper. Throws, with what was tried, when there is none. */
export async function resolveFullText(id: PaperId, resolver: Resolver): Promise<FullText> {
  const { reach } = resolver
  const tried: string[] = []
  if (id.kind === 'arxiv') {
    const found = await fromArxiv(id.id, resolver)
    if (found !== undefined) return found
    throw new Error(`arXiv has no readable copy of ${id.id} right now (HTML and PDF both failed). Check the id, or try again later.`)
  }
  if (id.kind === 'url') {
    const text = await pdfFrom(id.id, resolver)
    if (text !== undefined) return { text, source: 'the PDF at that address', structured: false, url: id.id }
    throw new Error('That address did not return a PDF with text. Give a DOI, an arXiv id, a PMID or a PMCID instead; for a web page use the web fetch tool.')
  }
  // Europe PMC knows whether PubMed Central holds the article as structured XML.
  const record = await quiet(epmcRecord(id.kind === 'doi' ? { doi: id.id } : id.kind === 'pmid' ? { pmid: id.id } : { pmcid: id.id }, reach), resolver)
  const pmcid = id.kind === 'pmcid' ? id.id : record?.pmcid
  if (pmcid !== undefined) {
    tried.push('PubMed Central')
    const xml = await quiet(epmcFullTextXml(pmcid, reach), resolver)
    const text = xml === undefined ? undefined : jatsToText(xml)
    if (text !== undefined) return { text, source: `PubMed Central (${pmcid})`, structured: true, url: `https://europepmc.org/article/PMC/${pmcid}` }
  }
  const doi = id.kind === 'doi' ? id.id : record?.doi
  const candidates: Array<{ url: string; from: string }> = []
  const add = (paper: Paper | undefined, from: string): void => { if (paper?.pdfUrl !== undefined && !candidates.some(candidate => candidate.url === paper.pdfUrl)) candidates.push({ url: paper.pdfUrl, from }) }
  add(record, 'Europe PMC')
  if (doi !== undefined) {
    const work = await quiet(openalexWork(`doi:${doi}`, reach), resolver)
    tried.push('OpenAlex')
    // The same work is often on arXiv too, where the text is cleanest.
    const preprint = work?.arxiv ?? (work?.pdfUrl === undefined ? undefined : arxivId(work.pdfUrl))
    if (preprint !== undefined) {
      const found = await fromArxiv(preprint, resolver)
      if (found !== undefined) return { ...found, source: `${found.source} (arXiv:${preprint}, the preprint of this paper)` }
    }
    add(work, 'OpenAlex')
    if (reach.keys.email) {
      tried.push('Unpaywall')
      const oa = await quiet(reach.http.json<{ best_oa_location?: { url_for_pdf?: string | null } | null; oa_locations?: Array<{ url_for_pdf?: string | null }> }>(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(reach.keys.email)}`, { signal: reach.signal }), resolver)
      for (const location of [oa?.best_oa_location, ...(oa?.oa_locations ?? [])]) if (location?.url_for_pdf && !candidates.some(candidate => candidate.url === location.url_for_pdf)) candidates.push({ url: location.url_for_pdf, from: 'Unpaywall' })
    }
    if (candidates.length === 0) { tried.push('Semantic Scholar'); add(await quiet(s2Paper(`DOI:${doi}`, reach), resolver), 'Semantic Scholar') }
  }
  for (const candidate of candidates.slice(0, 4)) {
    const preprint = arxivId(candidate.url)
    if (preprint !== undefined) {
      const found = await fromArxiv(preprint, resolver)
      if (found !== undefined) return found
      continue
    }
    const text = await pdfFrom(candidate.url, resolver)
    if (text !== undefined) return { text, source: `an open-access PDF (found via ${candidate.from})`, structured: false, url: candidate.url }
  }
  const where = [...new Set(tried)].join(', ')
  throw new Error(`No open-access full text found for ${id.id}${where ? ` (asked ${where}${candidates.length > 0 ? `; ${String(candidates.length)} PDF link(s) did not return a readable PDF` : ''})` : ''}. The paper is probably behind a paywall. If the user has it in Zotero, read it with zotero_read; otherwise work from the abstract (paper_get) and say the full text was not available.${reach.keys.email ? '' : ' Setting a contact e-mail in Settings > 学术 also lets the plugin ask Unpaywall.'}`)
}

/** Texts already fetched, kept on disk so a paper is downloaded once. */
export class TextCache {
  private readonly recent = new Map<string, FullText>()

  constructor(private readonly dir: string | undefined) {}

  private path(key: string): string | undefined {
    return this.dir === undefined ? undefined : join(this.dir, `${key.replace(/[^\w.-]+/g, '_').slice(0, 120)}.json`)
  }

  async get(key: string): Promise<FullText | undefined> {
    const hit = this.recent.get(key)
    if (hit !== undefined) return hit
    const path = this.path(key)
    if (path === undefined) return undefined
    try {
      const stored = JSON.parse(await readFile(path, 'utf8')) as FullText
      if (typeof stored.text !== 'string' || typeof stored.source !== 'string') return undefined
      this.remember(key, stored)
      return stored
    } catch {
      return undefined
    }
  }

  async set(key: string, value: FullText): Promise<void> {
    this.remember(key, value)
    const path = this.path(key)
    if (path === undefined || this.dir === undefined) return
    await mkdir(this.dir, { recursive: true }).then(() => writeFile(path, JSON.stringify(value), 'utf8')).catch(() => {})
  }

  private remember(key: string, value: FullText): void {
    this.recent.set(key, value)
    if (this.recent.size > 6) this.recent.delete(this.recent.keys().next().value!)
  }
}
