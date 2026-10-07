/**
 * Check references against Crossref (and DataCite, through doi.org): does
 * the DOI exist, does it belong to the work the reference names, do title,
 * first author and year agree, has the work been retracted. Catches the
 * references a language model makes up.
 */
import { titleKey } from './paper.js'
import { crossrefMatch, crossrefWork, SEARCHERS, type CrossrefWork, type Reach } from '../sources/indexes.js'
import { doiOf, type Csl } from '../zotero/csl.js'

export type Verdict = 'verified' | 'check' | 'not_found'

export interface Checked {
  reference: string
  verdict: Verdict
  /** What disagrees, or why nothing was found. */
  notes: string[]
  /** The record the reference was matched to. */
  matched?: { title: string; authors: string; year?: number; venue?: string; doi?: string }
}

const words = (text: string): string[] => titleKey(text).split(' ').filter(word => word.length > 1)

/** Share of the title's words that the reference contains, in [0, 1]. */
export function titleOverlap(title: string, reference: string): number {
  const wanted = words(title)
  if (wanted.length === 0) return 0
  const have = new Set(words(reference))
  return wanted.filter(word => have.has(word)).length / wanted.length
}

interface Record_ { title: string; family: string[]; year?: number; venue?: string; doi?: string; retracted: boolean }

function fromCrossref(work: CrossrefWork): Record_ {
  const year = work.issued?.['date-parts']?.[0]?.[0]
  return {
    title: (work.title?.[0] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    family: (work.author ?? []).map(author => author.family ?? author.name ?? '').filter(Boolean),
    ...(typeof year === 'number' ? { year } : {}),
    ...(work['container-title']?.[0] ? { venue: work['container-title'][0] } : {}),
    ...(work.DOI ? { doi: work.DOI } : {}),
    // Crossref marks a retraction notice on the record it retracts.
    retracted: (work['update-to'] ?? []).some(update => /retract|withdraw/i.test(update.type ?? '')) || /^(retracted|withdrawn)[:\s]/i.test(work.title?.[0] ?? ''),
  }
}

function fromCsl(csl: Csl, doi: string): Record_ {
  const year = Number((csl.issued ?? csl.published)?.['date-parts']?.[0]?.[0])
  const title = Array.isArray(csl.title) ? csl.title[0] ?? '' : csl.title ?? ''
  return { title: title.replace(/<[^>]+>/g, '').trim(), family: (csl.author ?? []).map(author => author.family ?? author.literal ?? '').filter(Boolean), ...(Number.isFinite(year) && year > 0 ? { year } : {}), doi, retracted: false }
}

function compare(reference: string, record: Record_): string[] {
  const notes: string[] = []
  const overlap = titleOverlap(record.title, reference)
  if (overlap < 0.6) notes.push(`title does not match: the record is "${record.title}"`)
  else if (overlap < 0.9) notes.push(`title differs in places: the record is "${record.title}"`)
  const text = titleKey(reference)
  const first = record.family[0]
  if (first !== undefined && !text.includes(titleKey(first))) notes.push(`first author "${first}" is not in the reference`)
  const years = [...reference.matchAll(/\b(19|20)\d{2}\b/g)].map(match => Number(match[0]))
  // A preprint and its published version are often a year apart.
  if (record.year !== undefined && years.length > 0 && !years.some(year => Math.abs(year - record.year!) <= 1)) notes.push(`year differs: the record says ${String(record.year)}`)
  if (record.retracted) notes.push('RETRACTED: this work has been retracted or withdrawn')
  return notes
}

const matchedOf = (record: Record_): NonNullable<Checked['matched']> => ({
  title: record.title, authors: record.family.slice(0, 3).join(', ') + (record.family.length > 3 ? ' et al.' : ''),
  ...(record.year === undefined ? {} : { year: record.year }), ...(record.venue === undefined ? {} : { venue: record.venue }), ...(record.doi === undefined ? {} : { doi: record.doi }),
})

export async function verifyReference(reference: string, reach: Reach): Promise<Checked> {
  const doi = doiOf(reference)
  if (doi !== undefined) {
    let record: Record_ | undefined
    const work = await crossrefWork(doi, reach)
    if (work !== undefined) record = fromCrossref(work)
    else {
      // DataCite DOIs (arXiv, Zenodo …) are not in Crossref; doi.org knows them all.
      try {
        record = fromCsl(await reach.http.json<Csl>(`https://doi.org/${encodeURI(doi)}`, { headers: { accept: 'application/vnd.citationstyles.csl+json' }, signal: reach.signal, retries: 1 }), doi)
      } catch (error) {
        if (reach.signal?.aborted) throw error
        if ((error as { status?: number }).status !== 404) throw error
      }
    }
    if (record === undefined) return { reference, verdict: 'not_found', notes: [`the DOI ${doi} does not exist`] }
    const notes = compare(reference, record)
    // A DOI that resolves to another work is the classic made-up reference.
    const wrongWork = notes.some(note => note.startsWith('title does not match'))
    return { reference, verdict: notes.length === 0 ? 'verified' : 'check', notes: wrongWork ? [`the DOI ${doi} belongs to a different work`, ...notes.slice(1)] : notes, matched: matchedOf(record) }
  }
  const candidates = (await crossrefMatch(reference, 4, reach)).map(fromCrossref).filter(candidate => candidate.title !== '')
  const best = candidates.map(candidate => ({ candidate, overlap: titleOverlap(candidate.title, reference) })).sort((a, b) => b.overlap - a.overlap)[0]
  if (best === undefined || best.overlap < 0.75) {
    // Crossref has no DOI-less venues (NeurIPS, ICLR) and no preprints; OpenAlex does.
    // Which part of the reference is the title is a guess (it may be the venue), and OpenAlex holds
    // several records of a much-copied paper: of all candidates, keep the one that disagrees least.
    let closest: { record: Record_; notes: string[] } | undefined
    for (const title of likelyTitles(reference)) {
      const hits = await SEARCHERS.openalex({ query: title, limit: 6, sort: 'relevance' }, reach).catch((error: unknown) => { if (reach.signal?.aborted) throw error; return [] })
      for (const paper of hits) {
        if (titleOverlap(paper.title, reference) < 0.85 || titleOverlap(title, paper.title) < 0.85) continue
        const record: Record_ = {
          title: paper.title, family: paper.authors.map(author => author.split(' ').at(-1) ?? author), retracted: paper.retracted === true,
          ...(paper.year === undefined ? {} : { year: paper.year }), ...(paper.venue === undefined ? {} : { venue: paper.venue }), ...(paper.doi === undefined ? {} : { doi: paper.doi }),
        }
        const found = compare(reference, record)
        if (found.length === 0) return { reference, verdict: 'verified', notes: [], matched: matchedOf(record) }
        // Another author and another year: a different work that shares the words.
        if (found.some(note => note.startsWith('first author')) && found.some(note => note.startsWith('year differs'))) continue
        if (closest === undefined || found.length < closest.notes.length) closest = { record, notes: found }
      }
    }
    // arXiv dates a preprint by its first version, which is the year most references give.
    for (const title of closest === undefined ? likelyTitles(reference).slice(0, 2) : [closest.record.title]) {
      const hits = await SEARCHERS.arxiv({ query: `ti:"${title.replace(/"/g, '')}"`, limit: 3, sort: 'relevance' }, reach).catch((error: unknown) => { if (reach.signal?.aborted) throw error; return [] })
      for (const paper of hits) {
        if (titleOverlap(paper.title, reference) < 0.85 || titleOverlap(title, paper.title) < 0.85) continue
        const record: Record_ = { title: paper.title, family: paper.authors.map(author => author.split(' ').at(-1) ?? author), retracted: false, venue: 'arXiv', ...(paper.year === undefined ? {} : { year: paper.year }), ...(paper.doi === undefined ? {} : { doi: paper.doi }) }
        const found = compare(reference, record)
        if (found.length === 0) return { reference, verdict: 'verified', notes: [], matched: matchedOf(record) }
        if (closest === undefined && !(found.some(note => note.startsWith('first author')) && found.some(note => note.startsWith('year differs')))) closest = { record, notes: found }
      }
    }
    if (closest !== undefined) return { reference, verdict: 'check', notes: closest.notes, matched: matchedOf(closest.record) }
    return { reference, verdict: 'not_found', notes: ['no record with this title in Crossref, OpenAlex or arXiv; it may be a preprint, a book, a non-English work, or it may not exist. Search for it with paper_search before relying on it.'] }
  }
  const notes = compare(reference, best.candidate)
  return { reference, verdict: notes.length === 0 ? 'verified' : 'check', notes, matched: matchedOf(best.candidate) }
}

/** The parts of a reference that may be its title: runs of words between full stops or quotes, longest first, at most three. */
export function likelyTitles(reference: string): string[] {
  return reference.replace(/https?:\/\/\S+|doi:\s*\S+/gi, ' ').split(/[.?!]\s+|["“”]/).map(part => part.trim())
    .filter(part => part.split(/\s+/).length >= 3 && !/\bet al\b|\bvol\b|\bpp\b|\d{4}.*\d{2,}/i.test(part) && (part.match(/,/g)?.length ?? 0) < 3)
    .sort((a, b) => b.length - a.length).slice(0, 3)
}

const LABEL: Record<Verdict, string> = { verified: 'VERIFIED', check: 'CHECK', not_found: 'NOT FOUND' }

export function formatChecked(checked: Checked, index: number): string {
  const matched = checked.matched
  return [
    `[${String(index)}] ${LABEL[checked.verdict]} — ${checked.reference.replace(/\s+/g, ' ').slice(0, 220)}`,
    ...checked.notes.map(note => `    ! ${note}`),
    matched === undefined ? '' : `    record: ${[matched.authors, matched.year, matched.title, matched.venue].filter(Boolean).join('. ')}${matched.doi ? ` https://doi.org/${matched.doi}` : ''}`,
  ].filter(Boolean).join('\n')
}
