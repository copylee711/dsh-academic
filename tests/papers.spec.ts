import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arxivHtmlToText, findSection, jatsToText, outlineOf } from '../src/fulltext/markup.js'
import { isPublicUrl, parsePaperId, resolveFullText, TextCache } from '../src/fulltext/resolve.js'
import { createHttp } from '../src/net/http.js'
import { bestId, mergeRanked, type Paper } from '../src/search/paper.js'
import { createPaperTools } from '../src/search/tools.js'
import { likelyTitles, titleOverlap, verifyReference } from '../src/search/verify.js'
import { resolveConfig } from '../src/settings.js'
import { arxivSearchQuery, invertedAbstract, paperFromCrossref, paperFromDblp, paperFromEpmc, paperFromOpenAlex, paperFromS2, parsePubmedXml } from '../src/sources/indexes.js'
import { run, settings } from './helpers.js'

type Route = (url: URL, init?: RequestInit) => Response | string | object | undefined

/** The web as a route function: a string or object is a 200, undefined a 404. */
function web(route: Route) {
  const seen: string[] = []
  const http = createHttp(async (input, init) => {
    seen.push(input)
    const reply = route(new URL(input), init)
    if (reply === undefined) return new Response('not found', { status: 404 })
    if (reply instanceof Response) return reply
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply))
  }, async () => {})
  return { http, seen }
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const LONG = 'The quick brown fox jumps over the lazy dog. '.repeat(20)

const ATOM = (entries: string): string => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entries}</feed>`
const ENTRY = (id: string, title: string, author = 'Ashish Vaswani'): string => `<entry><id>http://arxiv.org/abs/${id}v1</id><published>2017-06-12T00:00:00Z</published><title>${title}</title><summary>We propose the Transformer.</summary><author><name>${author}</name></author><category term="cs.CL"/></entry>`

describe('one paper from many indexes', () => {
  const preprint: Paper = { title: 'Attention Is All You Need', authors: ['A Vaswani'], arxiv: '1706.03762', abstract: 'short', sources: ['arXiv'] }
  const published: Paper = { title: 'Attention is all you need', authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017, doi: '10.5555/3295222.3295349', citations: 90000, venue: 'NeurIPS', abstract: 'a much longer abstract', sources: ['OpenAlex'] }
  const other: Paper = { title: 'A completely different paper about protein folding', authors: ['J Jumper'], doi: '10.1038/s41586-021-03819-2', sources: ['Crossref'] }

  it('merges by id and by title, keeping the best of each', () => {
    const merged = mergeRanked([[other, preprint], [published], [{ ...other, citations: 5, sources: ['OpenAlex'] }]])
    expect(merged).toHaveLength(2)
    const paper = merged.find(entry => entry.arxiv === '1706.03762')!
    expect(paper).toMatchObject({ doi: '10.5555/3295222.3295349', citations: 90000, venue: 'NeurIPS', abstract: 'a much longer abstract', pdfUrl: 'https://arxiv.org/pdf/1706.03762', sources: ['arXiv', 'OpenAlex'] })
    expect(paper.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer'])
    expect(bestId(paper)).toBe('arXiv:1706.03762')
    // Found by two indexes outranks found by one.
    expect(merged[0]!.doi).toBe('10.1038/s41586-021-03819-2')
    expect(merged[0]!.sources).toEqual(['Crossref', 'OpenAlex'])
  })
  it('knows an arXiv DOI and an arXiv id are the same paper', () => {
    const merged = mergeRanked([[{ title: 'X', authors: [], doi: '10.48550/arXiv.2010.11929', sources: ['OpenAlex'] }], [{ title: 'Y', authors: [], arxiv: '2010.11929', sources: ['arXiv'] }]])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.url).toBe('https://arxiv.org/abs/2010.11929')
  })
})

describe('what each index says, as a Paper', () => {
  it('builds an arXiv query that requires every word and keeps fielded queries', () => {
    expect(arxivSearchQuery({ query: 'diffusion models for "image generation"', limit: 5, sort: 'date', categories: ['cs.CV', 'cs.LG'], yearFrom: 2024 }))
      .toBe('((ti:diffusion OR abs:diffusion) AND (ti:models OR abs:models) AND (ti:"image generation" OR abs:"image generation")) AND (cat:cs.CV OR cat:cs.LG) AND submittedDate:[202401010000 TO 210012312359]')
    expect(arxivSearchQuery({ query: 'au:Hinton AND ti:dropout', limit: 5, sort: 'relevance' })).toBe('(au:Hinton AND ti:dropout)')
    expect(arxivSearchQuery({ query: 'graph networks', limit: 5, sort: 'relevance' }, true)).toBe('(ti:(graph networks) OR abs:(graph networks))')
  })
  it('reads OpenAlex, including its inverted abstract', () => {
    expect(invertedAbstract({ learning: [1], Deep: [0], works: [2] })).toBe('Deep learning works')
    expect(paperFromOpenAlex({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1038/NATURE14539', display_name: 'Deep learning', publication_year: 2015, authorships: [{ author: { display_name: 'Yann LeCun' } }], primary_location: { source: { display_name: 'Nature' } }, best_oa_location: { pdf_url: 'https://x.org/a.pdf' }, open_access: { is_oa: true }, cited_by_count: 9, is_retracted: true, ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/26017442' } }))
      .toEqual({ title: 'Deep learning', authors: ['Yann LeCun'], year: 2015, venue: 'Nature', doi: '10.1038/NATURE14539', pmid: '26017442', openalex: 'W1', pdfUrl: 'https://x.org/a.pdf', openAccess: true, citations: 9, retracted: true, sources: ['OpenAlex'] })
  })
  it('reads Crossref, Semantic Scholar, Europe PMC and DBLP', () => {
    expect(paperFromCrossref({ DOI: '10.1000/x', title: ['A <i>title</i>'], author: [{ given: 'Ada', family: 'Lovelace' }], issued: { 'date-parts': [[2020, 3, 5]] }, 'container-title': ['J. Tests'], abstract: '<jats:p>Hello</jats:p>', 'is-referenced-by-count': 3 }))
      .toEqual({ title: 'A title', authors: ['Ada Lovelace'], year: 2020, date: '2020-03-05', venue: 'J. Tests', abstract: 'Hello', doi: '10.1000/x', citations: 3, sources: ['Crossref'] })
    expect(paperFromS2({ paperId: 's2id', title: 'T', year: 2021, authors: [{ name: 'A B' }], externalIds: { ArXiv: '2101.00001', PubMedCentral: '123' }, tldr: { text: 'short' }, openAccessPdf: { url: '' } }))
      .toEqual({ title: 'T', authors: ['A B'], year: 2021, tldr: 'short', arxiv: '2101.00001', pmcid: 'PMC123', s2: 's2id', sources: ['Semantic Scholar'] })
    expect(paperFromEpmc({ title: 'An article.', authorString: 'Smith J, Doe A.', pubYear: '2022', pmid: '1', pmcid: 'PMC9', doi: '10.1000/e', isOpenAccess: 'Y', citedByCount: 2, journalInfo: { journal: { title: 'BMJ' } }, fullTextUrlList: { fullTextUrl: [{ documentStyle: 'html', availabilityCode: 'OA', url: 'https://h' }, { documentStyle: 'pdf', availabilityCode: 'OA', url: 'https://p.org/a.pdf' }] } }))
      .toEqual({ title: 'An article', authors: ['Smith J', 'Doe A'], year: 2022, venue: 'BMJ', doi: '10.1000/e', pmid: '1', pmcid: 'PMC9', pdfUrl: 'https://p.org/a.pdf', openAccess: true, citations: 2, sources: ['Europe PMC'] })
    expect(paperFromDblp({ info: { title: 'Deep Nets.', authors: { author: [{ text: 'Wei Wang 0001' }, { text: 'Li Li' }] }, venue: 'ICML', year: '2019', ee: 'https://arxiv.org/abs/1901.00001' } }))
      .toEqual({ title: 'Deep Nets', authors: ['Wei Wang', 'Li Li'], year: 2019, venue: 'ICML', arxiv: '1901.00001', url: 'https://arxiv.org/abs/1901.00001', sources: ['DBLP'] })
  })
  it('reads PubMed XML with structured abstracts and inline markup', () => {
    const xml = '<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">123</PMID><Article><Journal><JournalIssue><PubDate><Year>2023</Year></PubDate></JournalIssue><Title>The Lancet</Title></Journal><ArticleTitle>Effect of <i>X</i> on Y.</ArticleTitle><Abstract><AbstractText Label="BACKGROUND">Why.</AbstractText><AbstractText Label="RESULTS">What &lt; 5.</AbstractText></Abstract><AuthorList><Author><LastName>Doe</LastName><ForeName>Jane</ForeName></Author><Author><CollectiveName>The Group</CollectiveName></Author></AuthorList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">123</ArticleId><ArticleId IdType="doi">10.1016/x</ArticleId><ArticleId IdType="pmc">PMC77</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>'
    expect(parsePubmedXml(xml)).toEqual([{ title: 'Effect of X on Y', authors: ['Jane Doe', 'The Group'], year: 2023, venue: 'The Lancet', abstract: 'BACKGROUND: Why. RESULTS: What < 5.', doi: '10.1016/x', pmid: '123', pmcid: 'PMC77', sources: ['PubMed'] }])
  })
})

describe('papers as text', () => {
  const html = `<html><body><nav>skip</nav><article class="ltx_document"><h1 class="ltx_title">A Paper</h1><section><h2>1 Introduction</h2><p>We study <math alttext="x^{2}" display="inline"><mi>x</mi></math> &amp; more. ${LONG}</p><table><tr><td><math alttext="E=mc^{2}" display="block"><mi>E</mi></math></td><td>(1)</td></tr></table></section><section><h2>2 Method</h2><h3>2.1 Details</h3><p>Inner. ${LONG}</p><figure><img src="x.png"/><figcaption>Figure 1: The model.</figcaption></figure></section><section><h2>3 Results</h2><p>Good.</p></section></article></body></html>`

  it('keeps headings, formulas as LaTeX and figure captions from arXiv HTML', () => {
    const text = arxivHtmlToText(html)!
    expect(text).toContain('# A Paper')
    expect(text).toContain('## 1 Introduction\n\nWe study $x^{2}$ & more.')
    expect(text).toContain('$$E=mc^{2}$$')
    expect(text).toContain('[Figure 1: The model.]')
    expect(text).not.toContain('skip')
    expect(text).not.toMatch(/^\s*\|\s*$/m)
    expect(arxivHtmlToText('<html><body>No paper here</body></html>')).toBeUndefined()
  })
  it('reads by section', () => {
    const text = arxivHtmlToText(html)!
    const sections = outlineOf(text)
    expect(sections.map(section => `${section.id}:${String(section.level)}:${section.title}`)).toEqual(['1:1:A Paper', '2:2:1 Introduction', '3:2:2 Method', '4:3:2.1 Details', '5:2:3 Results'])
    const method = findSection(sections, 'method')!
    expect(text.slice(method.start, method.end)).toMatch(/^## 2 Method[\s\S]*### 2\.1 Details[\s\S]*Figure 1/)
    expect(text.slice(method.start, method.end)).not.toContain('3 Results')
    expect(findSection(sections, '4')!.title).toBe('2.1 Details')
    expect(findSection(sections, 'Results')!.id).toBe('5')
    expect(findSection(sections, 'appendix')).toBeUndefined()
  })
  it('reads PubMed Central XML with nested sections', () => {
    const text = jatsToText(`<article><front><article-title>Insect <italic>decline</italic></article-title><abstract><p>Fewer insects.</p></abstract></front><body><sec><title>Methods</title><p>Traps. ${LONG}</p><sec><title>Weather</title><p>Rain <xref>[1]</xref>.</p></sec></sec><sec><title>Results</title><p>Down 75%.</p><table-wrap><label>Table 1</label><caption><p>Biomass</p></caption><table><tr><td>a</td><td>b</td></tr></table></table-wrap></sec></body><back><ref-list><title>References</title><ref><mixed-citation>Smith 2000.</mixed-citation></ref></ref-list></back></article>`)!
    expect(text).toMatch(/^# Insect decline\n\n## Abstract\n\nFewer insects\./)
    expect(text).toContain('## Methods')
    expect(text).toContain('### Weather\n\nRain [1].')
    expect(text).toContain('## Results')
    expect(text).toContain('[Table 1 Biomass]')
    expect(text).toContain('## References\n\nSmith 2000.')
  })
})

describe('finding the open text', () => {
  it('tells the kinds of id apart', () => {
    expect(parsePaperId('arXiv:1706.03762v5')).toEqual({ kind: 'arxiv', id: '1706.03762' })
    expect(parsePaperId('https://doi.org/10.1038/nature14539')).toEqual({ kind: 'doi', id: '10.1038/nature14539' })
    expect(parsePaperId('10.48550/arXiv.2010.11929')).toEqual({ kind: 'arxiv', id: '2010.11929' })
    expect(parsePaperId('PMID: 26017442')).toEqual({ kind: 'pmid', id: '26017442' })
    expect(parsePaperId('pmc5646769')).toEqual({ kind: 'pmcid', id: 'PMC5646769' })
    expect(parsePaperId('https://example.org/paper.pdf')).toEqual({ kind: 'url', id: 'https://example.org/paper.pdf' })
    expect(parsePaperId('the transformer paper')).toBeUndefined()
  })
  it('fetches only from the public web', () => {
    for (const url of ['https://arxiv.org/pdf/1', 'http://example.org/a.pdf']) expect(isPublicUrl(url)).toBe(true)
    for (const url of ['http://localhost/a', 'http://127.0.0.1:23119/api', 'http://192.168.1.2/a', 'http://10.0.0.1/', 'http://172.20.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://intranet/', 'file:///c:/x', 'ftp://x.org/a', 'http://printer.local/']) expect(isPublicUrl(url)).toBe(false)
  })
  it('reads arXiv as HTML, falling back to ar5iv and then the PDF', async () => {
    const page = `<article><h1>T</h1><p>${LONG}</p></article>`
    const first = web(url => (url.host === 'arxiv.org' && url.pathname.startsWith('/html/') ? page : undefined))
    expect(await resolveFullText({ kind: 'arxiv', id: '2401.00001' }, { reach: { http: first.http, keys: {} }, pdfText: async () => '' })).toMatchObject({ source: 'arXiv\'s HTML version', structured: true })
    const second = web(url => (url.host === 'ar5iv.labs.arxiv.org' ? page : undefined))
    expect((await resolveFullText({ kind: 'arxiv', id: '1706.03762' }, { reach: { http: second.http, keys: {} }, pdfText: async () => '' })).source).toBe('ar5iv\'s HTML version')
    const third = web(url => (url.pathname.startsWith('/pdf/') ? new Response(PDF) : undefined))
    expect(await resolveFullText({ kind: 'arxiv', id: '1706.03762' }, { reach: { http: third.http, keys: {} }, pdfText: async () => `[page 1]\n${LONG}` })).toMatchObject({ source: 'the arXiv PDF', structured: false })
    expect(third.seen.map(url => new URL(url).host)).toEqual(['arxiv.org', 'ar5iv.labs.arxiv.org', 'arxiv.org'])
  })
  it('reads a DOI from PubMed Central when it is there', async () => {
    const { http } = web(url => {
      if (url.pathname.endsWith('/search')) return { resultList: { result: [{ title: 'T', pmcid: 'PMC9', doi: '10.1000/a', isOpenAccess: 'Y' }] } }
      if (url.pathname.endsWith('/PMC9/fullTextXML')) return `<article><body><sec><title>Intro</title><p>${LONG}</p></sec></body></article>`
      return undefined
    })
    expect(await resolveFullText({ kind: 'doi', id: '10.1000/a' }, { reach: { http, keys: {} }, pdfText: async () => '' })).toMatchObject({ source: 'PubMed Central (PMC9)', structured: true })
  })
  it('takes an open-access PDF an index points to, but not a login page, and asks Unpaywall only with an e-mail', async () => {
    const route: Route = url => {
      if (url.host === 'api.openalex.org') return { id: 'https://openalex.org/W1', display_name: 'T', best_oa_location: { pdf_url: 'https://publisher.org/wall.pdf' } }
      if (url.host === 'api.unpaywall.org') return { best_oa_location: { url_for_pdf: 'https://repo.org/open.pdf' } }
      if (url.host === 'publisher.org') return '<html>Please log in</html>'
      if (url.host === 'repo.org') return new Response(PDF)
      if (url.pathname.endsWith('/search')) return { resultList: { result: [] } }
      return undefined
    }
    const without = web(route)
    await expect(resolveFullText({ kind: 'doi', id: '10.1000/b' }, { reach: { http: without.http, keys: {} }, pdfText: async () => `[page 1]\n${LONG}` })).rejects.toThrow(/No open-access full text found for 10\.1000\/b[\s\S]*paywall[\s\S]*contact e-mail/)
    expect(without.seen.some(url => url.includes('unpaywall'))).toBe(false)
    const withEmail = web(route)
    expect(await resolveFullText({ kind: 'doi', id: '10.1000/b' }, { reach: { http: withEmail.http, keys: { email: 'me@example.org' } }, pdfText: async () => `[page 1]\n${LONG}` })).toMatchObject({ source: 'an open-access PDF (found via Unpaywall)', url: 'https://repo.org/open.pdf' })
    expect(withEmail.seen.find(url => url.includes('unpaywall'))).toContain('email=me%40example.org')
  })
  it('keeps what it fetched on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'academic-'))
    try {
      await new TextCache(dir).set('arxiv-1706.03762', { text: 'hello', source: 'test', structured: true })
      expect(await new TextCache(dir).get('arxiv-1706.03762')).toEqual({ text: 'hello', source: 'test', structured: true })
      expect(await new TextCache(dir).get('doi-10.1000/none')).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('checking references', () => {
  const lecun = { DOI: '10.1038/nature14539', title: ['Deep learning'], author: [{ family: 'LeCun' }, { family: 'Bengio' }], issued: { 'date-parts': [[2015]] }, 'container-title': ['Nature'] }
  const route: Route = url => {
    if (url.host === 'api.crossref.org' && url.pathname === '/works/10.1038%2Fnature14539') return { message: lecun }
    if (url.host === 'api.crossref.org' && url.pathname === '/works/10.1016%2Fretracted') return { message: { ...lecun, DOI: '10.1016/retracted', title: ['A bad study'], author: [{ family: 'Wakefield' }], issued: { 'date-parts': [[1998]] }, 'update-to': [{ type: 'retraction' }] } }
    if (url.host === 'api.crossref.org' && url.pathname === '/works') return { message: { items: url.searchParams.get('query.bibliographic')!.includes('residual') ? [{ DOI: '10.1109/cvpr.2016.90', title: ['Deep Residual Learning for Image Recognition'], author: [{ family: 'He' }], issued: { 'date-parts': [[2016]] } }] : [{ title: ['Something unrelated entirely'], author: [{ family: 'Nobody' }] }] } }
    if (url.host === 'api.openalex.org') return { results: [] }
    if (url.host === 'export.arxiv.org') return ATOM(url.searchParams.get('search_query')!.includes('Attention') ? ENTRY('1706.03762', 'Attention Is All You Need') : '')
    return undefined
  }
  const check = (reference: string) => verifyReference(reference, { http: web(route).http, keys: {} })

  it('measures how much of a title a reference contains', () => {
    expect(titleOverlap('Deep learning', 'LeCun Y. (2015). Deep Learning. Nature.')).toBe(1)
    expect(titleOverlap('Quantum gravity in transformer networks', 'LeCun (2015). Deep learning.')).toBe(0)
    expect(likelyTitles('Vaswani, A. et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems 30.')).toContain('Attention is all you need')
  })
  it('verifies a correct reference by DOI and by title', async () => {
    expect(await check('LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature 521. https://doi.org/10.1038/nature14539')).toMatchObject({ verdict: 'verified', notes: [], matched: { doi: '10.1038/nature14539' } })
    expect(await check('He K, Zhang X, Ren S, Sun J. Deep residual learning for image recognition. CVPR 2016.')).toMatchObject({ verdict: 'verified', matched: { doi: '10.1109/cvpr.2016.90' } })
    // No DOI and not in Crossref: found on arXiv.
    expect(await check('Vaswani, A. et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems 30.')).toMatchObject({ verdict: 'verified', matched: { venue: 'arXiv', year: 2017 } })
  })
  it('catches a real DOI attached to an invented paper', async () => {
    const checked = await check('Smith, J. (2021). Quantum gravity in transformer networks. Nature 590. https://doi.org/10.1038/nature14539')
    expect(checked.verdict).toBe('check')
    expect(checked.notes).toEqual(['the DOI 10.1038/nature14539 belongs to a different work', 'first author "LeCun" is not in the reference', 'year differs: the record says 2015'])
  })
  it('catches a DOI that does not exist and a paper nobody indexed', async () => {
    expect(await check('Doe, J. (2020). Made up. https://doi.org/10.9999/nothing')).toMatchObject({ verdict: 'not_found', notes: ['the DOI 10.9999/nothing does not exist'] })
    expect((await check('Zhang, W. (2023). A unified theory of imaginary gradient resonance in deep nets. JMLR 24.')).verdict).toBe('not_found')
  })
  it('flags wrong details and retractions', async () => {
    expect((await check('LeCun, Y. (2009). Deep learning. Nature. doi:10.1038/nature14539')).notes).toEqual(['year differs: the record says 2015'])
    expect((await check('Wakefield AJ (1998). A bad study. Lancet. doi:10.1016/retracted')).notes).toEqual(['RETRACTED: this work has been retracted or withdrawn'])
  })
})

describe('the paper tools', () => {
  const openalexWorks = [
    { id: 'https://openalex.org/W2', doi: 'https://doi.org/10.1000/famous', display_name: 'A famous survey of transformers', publication_year: 2021, cited_by_count: 5000, authorships: [{ author: { display_name: 'B Author' } }] },
    { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.5555/3295222.3295349', display_name: 'Attention is all you need', publication_year: 2017, cited_by_count: 90000, authorships: [{ author: { display_name: 'Ashish Vaswani' } }] },
  ]
  const route: Route = url => {
    if (url.host === 'export.arxiv.org') return ATOM(ENTRY('2301.00001', 'Transformers everywhere') + ENTRY('1706.03762', 'Attention Is All You Need'))
    if (url.host === 'api.openalex.org' && url.pathname === '/works') return { results: openalexWorks, meta: { count: 123 } }
    if (url.host === 'api.openalex.org') return openalexWorks[1]
    if (url.host === 'api.crossref.org') return new Response('busy', { status: 503 })
    if (url.host === 'doi.org') return url.pathname.includes('missing') ? undefined : `@article{key, title={T}, doi={${url.pathname.slice(1)}} }`
    if (url.host === 'arxiv.org' && url.pathname.startsWith('/pdf/')) return new Response(PDF)
    return undefined
  }
  const setup = (overrides = {}) => {
    const { http, seen } = web(route)
    return { seen, tools: createPaperTools({ settings: settings({ sources: ['arxiv', 'openalex', 'crossref'], ...overrides }), http, cache: new TextCache(undefined), pdfText: async () => '' }) }
  }

  it('searches the enabled indexes, merges, and says which did not answer', async () => {
    const { tools, seen } = setup()
    const text = await run(tools, 'paper_search', { query: 'Attention Is All You Need', limit: 3 })
    expect(text).toContain('3 papers for "Attention Is All You Need" (from arXiv, OpenAlex).')
    expect(text).toContain('Not answered: Crossref (HTTP 503 from api.crossref.org).')
    // The paper whose title was asked for comes first, as one record from both indexes.
    expect(text).toMatch(/\[1\] Attention Is All You Need\n\s+Ashish Vaswani · 2017 · arXiv\n\s+id: arXiv:1706\.03762 · cited 90000 · open access · via arXiv, OpenAlex\n\s+https:\/\/arxiv\.org\/abs\/1706\.03762/)
    expect(new Set(seen.map(url => new URL(url).host))).toEqual(new Set(['export.arxiv.org', 'api.openalex.org', 'api.crossref.org']))
    expect(text).toMatch(/<untrusted-external-content>[\s\S]*<\/untrusted-external-content>$/)
  })
  it('asks only the indexes named, sorts by citations here, and caps the count', async () => {
    const { tools, seen } = setup({ maxResults: 2 })
    const text = await run(tools, 'paper_search', { query: 'transformers', sources: ['openalex'], sort: 'citations', limit: 50, abstract: 'none' })
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]!).searchParams.get('sort')).toBeNull()
    expect(text.indexOf('Attention is all you need')).toBeLessThan(text.indexOf('A famous survey'))
    expect(text).toContain('2 papers')
    await expect(run(setup({ sources: [] }).tools, 'paper_search', { query: 'x' })).rejects.toThrow(/every source is switched off/)
  })
  it('follows citation links through OpenAlex', async () => {
    const { tools, seen } = setup()
    const text = await run(tools, 'paper_citations', { id: '10.5555/3295222.3295349', direction: 'citations', limit: 2 })
    expect(text).toContain('123 papers cite "Attention is all you need"; showing the 2 most cited.')
    expect(new URL(seen.at(-1)!).searchParams.get('filter')).toBe('cites:W1')
    await expect(run(tools, 'paper_citations', { id: 'some title', direction: 'references' })).rejects.toThrow(/Give a DOI/)
  })
  it('cites from the DOI registry and never invents an entry', async () => {
    const { tools, seen } = setup({ citationStyle: 'ieee' })
    const text = await run(tools, 'paper_cite', { ids: ['10.1000/a', 'arXiv:1706.03762', '10.1000/missing', 'a title'], format: 'bibtex' })
    expect(text).toContain('Citations from the DOI registries (bibtex): 2 of 4.')
    expect(text).toContain('doi={10.48550/arXiv.1706.03762}')
    expect(text).toContain('10.1000/missing: this DOI does not exist')
    expect(text).toContain('a title: no DOI known for it')
    await run(tools, 'paper_cite', { ids: ['10.1000/a'], format: 'text', locale: 'zh-CN' })
    expect(seen.at(-1)).toBe('https://doi.org/10.1000/a')
  })
  it('saves an open PDF inside the workspace only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'academic-ws-'))
    try {
      const { tools } = setup()
      const tool = tools.find(candidate => candidate.name === 'paper_download')!
      const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: dir } } } }
      const result = await (tool.execute as (args: unknown, exec: unknown) => Promise<{ text: string }>)({ id: '1706.03762', filename: '../../escape.pdf' }, exec)
      expect(result.text).toContain('to papers/escape.pdf')
      expect(new Uint8Array(await readFile(join(dir, 'papers', 'escape.pdf')))).toEqual(PDF)
      await expect((tool.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ id: '1706.03762' }, { signal: exec.signal })).rejects.toThrow(/no workspace folder/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('search settings', () => {
  it('keeps known sources only and a well-formed e-mail', () => {
    expect(resolveConfig({ sources: ['arxiv', 'scihub', 'arxiv', 'dblp'], email: ' me@example.org ', s2Key: { get: () => ' k ' } })).toMatchObject({ sources: ['arxiv', 'dblp'], email: 'me@example.org', s2Key: 'k' })
    expect(resolveConfig({ email: 'not an address', sources: 'arxiv' })).toMatchObject({ email: '', sources: ['arxiv', 'openalex', 'crossref', 'semanticscholar', 'pubmed', 'europepmc'] })
  })
})
