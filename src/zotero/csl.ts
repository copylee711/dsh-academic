/**
 * Turn what the DOI registries and arXiv say about a work into a Zotero item.
 * Only fields every Zotero schema has for the type are set; the rest of what
 * identifies the work goes to `extra`, which every type has.
 */
import type { ArxivPaper } from '../sources/arxiv.js'
import type { Creator } from './format.js'

/** CSL JSON as doi.org returns it (`Accept: application/vnd.citationstyles.csl+json`). */
export interface Csl {
  type?: string
  title?: string | string[]
  author?: Array<{ given?: string; family?: string; literal?: string; name?: string }>
  editor?: Array<{ given?: string; family?: string; literal?: string }>
  issued?: { 'date-parts'?: Array<Array<number | string>> }
  published?: { 'date-parts'?: Array<Array<number | string>> }
  'container-title'?: string | string[]
  'container-title-short'?: string | string[]
  volume?: string
  issue?: string
  page?: string
  DOI?: string
  URL?: string
  ISSN?: string | string[]
  ISBN?: string | string[]
  publisher?: string
  'publisher-place'?: string
  abstract?: string
  language?: string
  subtype?: string
  event?: string | { name?: string }
}

export type NewItem = Record<string, unknown> & { itemType: string; title: string; creators: Creator[] }

const TYPES: Record<string, string> = {
  'journal-article': 'journalArticle', 'article-journal': 'journalArticle', article: 'preprint', 'posted-content': 'preprint',
  'proceedings-article': 'conferencePaper', 'paper-conference': 'conferencePaper',
  book: 'book', monograph: 'book', 'edited-book': 'book', 'reference-book': 'book',
  'book-chapter': 'bookSection', chapter: 'bookSection', 'book-section': 'bookSection',
  dissertation: 'thesis', thesis: 'thesis', report: 'report', 'report-component': 'report',
  dataset: 'dataset', software: 'computerProgram', webpage: 'webpage',
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? '' : value ?? '').replace(/\s+/g, ' ').trim()

const stripTags = (value: string): string => value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

function people(list: Csl['author'], creatorType: string): Creator[] {
  return (list ?? []).map(person => person.family
    ? { creatorType, firstName: person.given ?? '', lastName: person.family }
    : { creatorType, name: person.literal ?? person.name ?? person.given ?? '' })
    .filter(creator => (creator.lastName ?? creator.name) !== '')
}

function dateOf(csl: Csl): string {
  const parts = (csl.issued ?? csl.published)?.['date-parts']?.[0] ?? []
  return parts.filter(part => part !== '' && part !== null).map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-')
}

export function itemFromCsl(csl: Csl, doi: string): NewItem {
  const itemType = TYPES[csl.type ?? ''] ?? 'document'
  const container = stripTags(first(csl['container-title']))
  const item: NewItem = {
    itemType,
    title: stripTags(first(csl.title)) || doi,
    // Software has programmers where other types have authors.
    creators: [...people(csl.author, itemType === 'computerProgram' ? 'programmer' : 'author'), ...(itemType === 'book' ? people(csl.editor, 'editor') : [])],
  }
  const set = (field: string, value: string | undefined): void => { if (value) item[field] = value }
  // Publishers deposit the heading with the text: "<jats:title>Abstract</jats:title><jats:p>…".
  set('abstractNote', csl.abstract === undefined ? undefined : stripTags(csl.abstract.replace(/^\s*<jats:title>[^<]{0,30}<\/jats:title>/i, '')).replace(/^(Abstract|Summary)[\s:.]+(?=[A-Z])/, ''))
  set('date', dateOf(csl))
  set('url', `https://doi.org/${doi}`)
  set('language', csl.language)
  const extra: string[] = []
  switch (itemType) {
    case 'journalArticle':
      set('publicationTitle', container); set('journalAbbreviation', first(csl['container-title-short'])); set('volume', csl.volume); set('issue', csl.issue); set('pages', csl.page); set('ISSN', first(csl.ISSN)); set('DOI', doi)
      break
    case 'conferencePaper':
      set('proceedingsTitle', container); set('conferenceName', typeof csl.event === 'string' ? csl.event : csl.event?.name); set('pages', csl.page); set('publisher', csl.publisher); set('ISBN', first(csl.ISBN)); set('DOI', doi)
      break
    case 'preprint':
      set('repository', csl.publisher || container); set('DOI', doi)
      break
    case 'book':
      set('publisher', csl.publisher); set('place', csl['publisher-place']); set('ISBN', first(csl.ISBN)); extra.push(`DOI: ${doi}`)
      break
    case 'bookSection':
      set('bookTitle', container); set('publisher', csl.publisher); set('pages', csl.page); set('ISBN', first(csl.ISBN)); extra.push(`DOI: ${doi}`)
      break
    case 'thesis':
      set('university', csl.publisher); extra.push(`DOI: ${doi}`)
      break
    case 'report':
      set('institution', csl.publisher); extra.push(`DOI: ${doi}`)
      break
    default:
      extra.push(`DOI: ${doi}`)
      if (csl.publisher) extra.push(`Publisher: ${csl.publisher}`)
  }
  if (extra.length > 0) item.extra = extra.join('\n')
  return item
}

export function itemFromArxiv(paper: ArxivPaper): NewItem {
  const split = (name: string): Creator => {
    const cut = name.lastIndexOf(' ')
    return cut === -1 ? { creatorType: 'author', name } : { creatorType: 'author', firstName: name.slice(0, cut), lastName: name.slice(cut + 1) }
  }
  const extra = [paper.journalRef ? `Journal reference: ${paper.journalRef}` : '', paper.comment ? `Comment: ${paper.comment}` : ''].filter(Boolean)
  return {
    itemType: 'preprint',
    title: paper.title,
    creators: paper.authors.map(split),
    abstractNote: paper.abstract,
    date: paper.published.slice(0, 10),
    repository: 'arXiv',
    archiveID: `arXiv:${paper.id}`,
    DOI: paper.doi ?? `10.48550/arXiv.${paper.id}`,
    url: `https://arxiv.org/abs/${paper.id}`,
    ...(extra.length > 0 ? { extra: extra.join('\n') } : {}),
    tags: paper.categories.slice(0, 1).map(tag => ({ tag })),
  }
}

/** What survives on any item type: used when Zotero refuses a field of the full item. */
export function minimalItem(item: NewItem): NewItem {
  const doi = typeof item.DOI === 'string' ? item.DOI : undefined
  const extra = [typeof item.extra === 'string' ? item.extra : '', doi && !String(item.extra ?? '').includes(doi) ? `DOI: ${doi}` : ''].filter(Boolean).join('\n')
  return {
    itemType: 'document',
    title: item.title,
    creators: item.creators.map(creator => ({ ...creator, creatorType: 'author' })),
    ...(typeof item.abstractNote === 'string' ? { abstractNote: item.abstractNote } : {}),
    ...(typeof item.date === 'string' ? { date: item.date } : {}),
    ...(typeof item.url === 'string' ? { url: item.url } : {}),
    ...(extra ? { extra } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags } : {}),
    ...(Array.isArray(item.collections) ? { collections: item.collections } : {}),
  }
}

/** A DOI out of a bare DOI, a `doi:` label or a doi.org URL; undefined when there is none. */
export function doiOf(input: string): string | undefined {
  const match = /(10\.\d{4,9}\/[^\s"<>]+)/.exec(decodeURIComponent(input.trim()))
  return match?.[1]?.replace(/[.,;)\]]+$/, '')
}
