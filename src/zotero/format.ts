/** Zotero API objects, and the plain text the model reads about them. */
import { formatRef, type Library } from './refs.js'

export interface Creator { creatorType?: string; firstName?: string; lastName?: string; name?: string }

export interface ItemData {
  key: string
  version?: number
  itemType: string
  title?: string
  creators?: Creator[]
  date?: string
  abstractNote?: string
  publicationTitle?: string
  proceedingsTitle?: string
  bookTitle?: string
  publisher?: string
  university?: string
  repository?: string
  volume?: string
  issue?: string
  pages?: string
  DOI?: string
  url?: string
  extra?: string
  tags?: Array<{ tag: string; type?: number }>
  collections?: string[]
  parentItem?: string
  dateAdded?: string
  dateModified?: string
  // Notes
  note?: string
  // Attachments
  linkMode?: string
  contentType?: string
  filename?: string
  path?: string
  // Annotations
  annotationType?: string
  annotationText?: string
  annotationComment?: string
  annotationColor?: string
  annotationPageLabel?: string
  [field: string]: unknown
}

export interface Item {
  key: string
  version?: number
  meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number }
  links?: { attachment?: { href?: string; attachmentType?: string; attachmentSize?: number } }
  data: ItemData
}

export interface Collection {
  key: string
  meta?: { numItems?: number; numCollections?: number }
  data: { key: string; name: string; parentCollection?: string | false }
}

export function creatorName(creator: Creator): string {
  return creator.name ?? [creator.firstName, creator.lastName].filter(Boolean).join(' ')
}

export function creatorSummary(item: Item): string {
  if (item.meta?.creatorSummary) return item.meta.creatorSummary
  const authors = (item.data.creators ?? []).filter(creator => creator.creatorType === undefined || creator.creatorType === 'author')
  const names = (authors.length > 0 ? authors : item.data.creators ?? []).map(creator => creator.lastName ?? creator.name ?? '').filter(Boolean)
  if (names.length === 0) return ''
  return names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]!} and ${names[1]!}` : `${names[0]!} et al.`
}

export function yearOf(item: Item): string {
  return /\d{4}/.exec(item.meta?.parsedDate ?? item.data.date ?? '')?.[0] ?? ''
}

export function venueOf(data: ItemData): string {
  return data.publicationTitle || data.proceedingsTitle || data.bookTitle || data.university || data.repository || data.publisher || ''
}

/** Text of a note or a citation: tags dropped, entities read, blank runs closed up. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`
}

const FILE_KINDS: Record<string, string> = { 'application/pdf': 'pdf', 'text/html': 'snapshot', 'application/epub+zip': 'epub' }

/** One search hit: a numbered headline, a line of facts, the ref. */
export function formatHit(item: Item, library: Library, index: number, abstractChars = 0): string {
  const data = item.data
  const facts = [creatorSummary(item), yearOf(item), data.itemType, venueOf(data)].filter(Boolean).join(' · ')
  const attachment = item.links?.attachment?.attachmentType
  const extras = [
    data.DOI ? `DOI ${data.DOI}` : '',
    attachment ? `has ${FILE_KINDS[attachment] ?? attachment}` : '',
    (data.tags?.length ?? 0) > 0 ? `tags: ${data.tags!.slice(0, 6).map(tag => tag.tag).join(', ')}` : '',
  ].filter(Boolean).join(' · ')
  return [
    `[${String(index)}] ${data.title || '(untitled)'}`,
    facts ? `    ${facts}` : '',
    `    ${formatRef(library, item.key)}${extras ? ` · ${extras}` : ''}`,
    abstractChars > 0 && data.abstractNote ? `    ${clip(data.abstractNote.replace(/\s+/g, ' '), abstractChars)}` : '',
  ].filter(Boolean).join('\n')
}

const SKIP = new Set(['key', 'version', 'itemType', 'title', 'creators', 'abstractNote', 'tags', 'collections', 'relations', 'dateAdded', 'dateModified', 'parentItem', 'note', 'accessDate'])

/** Everything Zotero holds on one item, as labelled lines. */
export function formatItem(item: Item, library: Library, collectionNames: ReadonlyMap<string, string>): string {
  const data = item.data
  const creators = (data.creators ?? []).map(creator => `${creatorName(creator)}${creator.creatorType && creator.creatorType !== 'author' ? ` (${creator.creatorType})` : ''}`)
  const lines = [
    data.title || '(untitled)',
    `ref: ${formatRef(library, item.key)}`,
    `type: ${data.itemType}`,
    creators.length > 0 ? `creators: ${creators.join('; ')}` : '',
  ]
  for (const [field, value] of Object.entries(data)) {
    if (SKIP.has(field) || typeof value !== 'string' || value === '') continue
    lines.push(`${field}: ${clip(value.replace(/\s+/g, ' '), 400)}`)
  }
  if ((data.tags?.length ?? 0) > 0) lines.push(`tags: ${data.tags!.map(tag => tag.tag).join(', ')}`)
  if ((data.collections?.length ?? 0) > 0) lines.push(`collections: ${data.collections!.map(key => collectionNames.get(key) ?? key).join('; ')}`)
  if (data.dateAdded) lines.push(`added: ${data.dateAdded}`)
  if (data.abstractNote) lines.push('', 'abstract:', data.abstractNote.trim())
  return lines.filter((line, index) => line !== '' || index > 3).join('\n')
}

export function formatAttachment(item: Item, library: Library): string {
  const data = item.data
  const kind = FILE_KINDS[data.contentType ?? ''] ?? data.contentType ?? 'file'
  return `- ${data.title || data.filename || '(attachment)'} [${kind}${data.linkMode === 'linked_url' ? ', web link' : ''}] ${formatRef(library, item.key)}`
}

export function formatAnnotation(item: Item): string {
  const data = item.data
  const page = data.annotationPageLabel ? `p. ${data.annotationPageLabel}` : ''
  const head = [data.annotationType ?? 'annotation', page].filter(Boolean).join(', ')
  const quote = data.annotationText ? `"${clip(data.annotationText.replace(/\s+/g, ' '), 600)}"` : ''
  const comment = data.annotationComment ? `note: ${clip(data.annotationComment.replace(/\s+/g, ' '), 600)}` : ''
  return `- (${head}) ${[quote, comment].filter(Boolean).join(' — ')}`
}

/** `Parent / Child` for every collection key. */
export function collectionPaths(collections: readonly Collection[]): Map<string, string> {
  const byKey = new Map(collections.map(collection => [collection.key, collection]))
  const paths = new Map<string, string>()
  const pathOf = (key: string, depth = 0): string => {
    const known = paths.get(key)
    if (known !== undefined) return known
    const collection = byKey.get(key)
    if (collection === undefined) return key
    const parent = collection.data.parentCollection
    const path = typeof parent === 'string' && parent !== '' && depth < 20 ? `${pathOf(parent, depth + 1)} / ${collection.data.name}` : collection.data.name
    paths.set(key, path)
    return path
  }
  for (const collection of collections) pathOf(collection.key)
  return paths
}
