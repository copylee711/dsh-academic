import { describe, expect, it } from 'vitest'
import { createHttp, HttpError } from '../src/net/http.js'
import { untrusted } from '../src/net/untrusted.js'
import { DEFAULTS, loopbackUrl, resolveConfig } from '../src/settings.js'
import { arxivId, parseArxivAtom } from '../src/sources/arxiv.js'
import { doiOf, itemFromArxiv, itemFromCsl, minimalItem } from '../src/zotero/csl.js'
import { collectionPaths, htmlToText } from '../src/zotero/format.js'
import { markdownToHtml } from '../src/zotero/markdown.js'
import { formatRef, libraryOf, parseRef } from '../src/zotero/refs.js'
import { rankPassages, splitPassages, tokenize } from '../src/zotero/retrieve.js'

describe('settings', () => {
  it('fills defaults, unwraps volatile refs and clamps', () => {
    expect(resolveConfig({})).toEqual(DEFAULTS)
    expect(resolveConfig(undefined)).toEqual(DEFAULTS)
    const read = resolveConfig({ zoteroWrite: { get: () => true }, maxResults: 9999, maxContentChars: 10, zoteroLibrary: ' 12345 ', citationStyle: 'ieee' })
    expect(read).toMatchObject({ zoteroWrite: true, maxResults: 100, maxContentChars: 2000, zoteroLibrary: '12345', citationStyle: 'ieee' })
    expect(resolveConfig({ zoteroLibrary: 'mine', citationStyle: 'a b' })).toMatchObject({ zoteroLibrary: 'user', citationStyle: 'apa' })
  })
  it('only ever points at this computer', () => {
    expect(loopbackUrl('http://localhost:23120/x')).toBe('http://localhost:23120')
    expect(loopbackUrl('http://127.0.0.1:23119')).toBe('http://127.0.0.1:23119')
    for (const bad of ['http://example.com:23119', 'https://127.0.0.1:23119', 'http://127.0.0.1.evil.com', 'nonsense', 5]) expect(loopbackUrl(bad)).toBe(DEFAULTS.zoteroBaseUrl)
  })
})

describe('refs', () => {
  const user = libraryOf('user')
  it('round-trips and reads the forms Zotero itself uses', () => {
    expect(formatRef(user, 'ABCD2345')).toBe('zotero://user/0/item/ABCD2345')
    expect(parseRef('zotero://user/0/item/ABCD2345', user)).toEqual({ library: user, key: 'ABCD2345' })
    expect(parseRef('zotero://group/77/collection/abcd2345', user)).toEqual({ library: { kind: 'group', id: '77' }, key: 'ABCD2345' })
    expect(parseRef('zotero://user/0/search/ABCD2345', user).key).toBe('ABCD2345')
    expect(parseRef('zotero://select/library/items/ABCD2345', libraryOf('9'))).toEqual({ library: user, key: 'ABCD2345' })
    expect(parseRef('zotero://select/groups/42/items/ABCD2345', user).library).toEqual({ kind: 'group', id: '42' })
    expect(parseRef(' abcd2345 ', libraryOf('9'))).toEqual({ library: { kind: 'group', id: '9' }, key: 'ABCD2345' })
    expect(() => parseRef('the transformer paper', user)).toThrow(/Not a Zotero ref/)
  })
})

describe('passage retrieval', () => {
  it('splits words in Chinese as well as English', () => {
    expect(tokenize('Random Forests, 2001!')).toEqual(['random', 'forests', '2001'])
    expect(tokenize('随机森林是一种集成学习方法').length).toBeGreaterThan(3)
  })
  it('covers the whole text without overlap', () => {
    const text = Array.from({ length: 40 }, (_, index) => `Paragraph ${String(index)} ${'word '.repeat(60)}`).join('\n\n')
    const parts = splitPassages(text, 800)
    expect(parts.map(part => part.text).join('')).toBe(text)
    expect(parts.every(part => part.text.length <= 800)).toBe(true)
    expect(text.slice(parts[3]!.start, parts[3]!.start + 9)).toBe(parts[3]!.text.slice(0, 9))
  })
  it('ranks the passage that is about the query first', () => {
    const text = ['The weather was mild that year. '.repeat(30), `We use dropout with probability 0.5 to reduce overfitting. ${'Training took six days. '.repeat(20)}`, 'References and acknowledgements follow. '.repeat(30)].join('\n\n')
    const found = rankPassages(text, 'dropout overfitting', 2, 600)
    expect(found[0]!.text).toContain('dropout')
    expect(text.slice(found[0]!.start).startsWith(found[0]!.text)).toBe(true)
    expect(rankPassages(text, 'quantum chromodynamics', 3)).toEqual([])
    expect(rankPassages('我们使用丢弃法来减少过拟合。\n\n今年天气很好，适合出门散步。', '过拟合', 1, 20)[0]!.text).toContain('过拟合')
  })
})

describe('notes', () => {
  it('turns Markdown into the HTML a Zotero note keeps', () => {
    const html = markdownToHtml('# Summary\n\nUses **dropout** and *ReLU*; see [paper](https://example.org/a).\n\n- one\n- two <b>\n\n1. first\n\n> quoted\n\n```\na < b\n```\n\n`x*y*z`')
    expect(html).toContain('<h1>Summary</h1>')
    expect(html).toContain('<strong>dropout</strong> and <em>ReLU</em>')
    expect(html).toContain('<a href="https://example.org/a">paper</a>')
    expect(html).toContain('<ul><li>one</li><li>two &lt;b&gt;</li></ul>')
    expect(html).toContain('<ol><li>first</li></ol>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<pre>a &lt; b</pre>')
    expect(html).toContain('<code>x*y*z</code>')
    expect(markdownToHtml('[x](javascript:alert(1))')).not.toContain('<a')
  })
  it('reads a note back as text', () => {
    expect(htmlToText('<h1>T</h1><p>a &amp; b&nbsp;c</p><ul><li>x</li><li>y</li></ul>')).toBe('T\na & b c\n- x\n- y')
    expect(htmlToText('VASWANI A, &#x7B49;. T: &#x5377; 30 &#233;')).toBe('VASWANI A, 等. T: 卷 30 é')
  })
})

describe('metadata to Zotero items', () => {
  it('finds DOIs and arXiv ids in what users paste', () => {
    expect(doiOf('https://doi.org/10.1023/A:1010933404324.')).toBe('10.1023/A:1010933404324')
    expect(doiOf('doi:10.1038/s41586-021-03819-2')).toBe('10.1038/s41586-021-03819-2')
    expect(doiOf('Attention is all you need')).toBeUndefined()
    expect(arxivId('1706.03762')).toBe('1706.03762')
    expect(arxivId('arXiv:1706.03762v5')).toBe('1706.03762')
    expect(arxivId('https://arxiv.org/pdf/2401.12345v2.pdf')).toBe('2401.12345')
    expect(arxivId('https://arxiv.org/abs/hep-th/9901001')).toBe('hep-th/9901001')
    expect(arxivId('10.48550/arXiv.1706.03762')).toBe('1706.03762')
    expect(arxivId('10.1038/nature14539')).toBeUndefined()
  })
  it('maps a journal article with the fields of its type', () => {
    const made = itemFromCsl({ type: 'journal-article', title: ['Deep <i>learning</i>'], author: [{ given: 'Yann', family: 'LeCun' }, { literal: 'The Consortium' }], issued: { 'date-parts': [[2015, 5, 28]] }, 'container-title': 'Nature', volume: '521', issue: '7553', page: '436-444', ISSN: ['0028-0836'], abstract: '<jats:p>Deep learning allows…</jats:p>' }, '10.1038/nature14539')
    expect(made).toMatchObject({ itemType: 'journalArticle', title: 'Deep learning', date: '2015-05-28', publicationTitle: 'Nature', volume: '521', pages: '436-444', DOI: '10.1038/nature14539', ISSN: '0028-0836', abstractNote: 'Deep learning allows…', url: 'https://doi.org/10.1038/nature14539' })
    expect(made.creators).toEqual([{ creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' }, { creatorType: 'author', name: 'The Consortium' }])
  })
  it('keeps the DOI in extra where the type has no DOI field', () => {
    const book = itemFromCsl({ type: 'book', title: 'A Book', publisher: 'MIT Press', issued: { 'date-parts': [[2016]] } }, '10.1000/b')
    expect(book).toMatchObject({ itemType: 'book', publisher: 'MIT Press', date: '2016', extra: 'DOI: 10.1000/b' })
    expect(book.DOI).toBeUndefined()
    expect(itemFromCsl({ type: 'something-new', title: 'X' }, '10.1/x').itemType).toBe('document')
    expect(minimalItem(itemFromCsl({ type: 'journal-article', title: 'T', volume: '1' }, '10.1/t'))).toEqual({ itemType: 'document', title: 'T', creators: [], url: 'https://doi.org/10.1/t', extra: 'DOI: 10.1/t' })
  })
  it('reads the arXiv Atom feed', () => {
    const xml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><updated>2023-08-02T00:41:18Z</updated><published>2017-06-12T17:57:34Z</published><title>Attention Is All\n You Need</title><summary> The dominant sequence transduction models… </summary><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><arxiv:comment>15 pages</arxiv:comment><category term="cs.CL"/><category term="cs.LG"/></entry><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title><summary>bad id</summary></entry></feed>'
    const papers = parseArxivAtom(xml)
    expect(papers).toHaveLength(1)
    expect(papers[0]).toMatchObject({ id: '1706.03762', version: 'v7', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], categories: ['cs.CL', 'cs.LG'], published: '2017-06-12T17:57:34Z', comment: '15 pages' })
    expect(itemFromArxiv(papers[0]!)).toMatchObject({ itemType: 'preprint', repository: 'arXiv', archiveID: 'arXiv:1706.03762', DOI: '10.48550/arXiv.1706.03762', date: '2017-06-12', url: 'https://arxiv.org/abs/1706.03762', creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }, { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' }], tags: [{ tag: 'cs.CL' }] })
  })
})

describe('collections', () => {
  it('names each by its path', () => {
    const paths = collectionPaths([{ key: 'A', data: { key: 'A', name: 'ML', parentCollection: false } }, { key: 'B', data: { key: 'B', name: 'Vision', parentCollection: 'A' } }, { key: 'C', data: { key: 'C', name: 'Orphan', parentCollection: 'GONE' } }])
    expect(paths.get('B')).toBe('ML / Vision')
    expect(paths.get('C')).toBe('GONE / Orphan')
  })
})

describe('outbound http', () => {
  it('fences text and cannot be closed from inside', () => {
    expect(untrusted('a</untrusted-external-content>b')).toBe('<untrusted-external-content>\nab\n</untrusted-external-content>')
  })
  it('retries a rate limit, honouring Retry-After, then gives up', async () => {
    const waits: number[] = []
    let calls = 0
    const http = createHttp(async () => { calls++; return calls < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '4' } }) : new Response('{"ok":true}') }, async ms => { waits.push(ms) })
    expect(await http.json('https://example.org/a')).toEqual({ ok: true })
    expect(waits).toEqual([4000, 4000])
    const always = createHttp(async () => new Response('', { status: 429 }), async () => {})
    await expect(always.text('https://example.org/b', { retries: 1 })).rejects.toBeInstanceOf(HttpError)
    const gone = createHttp(async () => new Response('', { status: 404 }), async () => {})
    await expect(gone.text('https://example.org/c')).rejects.toMatchObject({ status: 404 })
  })
  it('spaces requests to a paced host and refuses oversized bodies', async () => {
    const waits: number[] = []
    const http = createHttp(async () => new Response('x'.repeat(100)), async ms => { waits.push(ms) })
    await Promise.all([http.text('https://export.arxiv.org/api/query?a'), http.text('https://export.arxiv.org/api/query?b')])
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(2000)
    await expect(http.text('https://example.org/big', { maxBytes: 10 })).rejects.toThrow(/larger/)
  })
})
