import { describe, expect, it } from 'vitest'
import { findBrowser } from '../src/browser/find.js'
import type { Tab, WebBrowser } from '../src/browser/session.js'
import { cnkiSearch, HumanCheckError, paperFromCnki, paperFromScholar, scholarSearch, scholarUrl, type CnkiRow, type ScholarRow } from '../src/browser/sites.js'
import { createHttp } from '../src/net/http.js'
import { cjkTitle, verifyReference } from '../src/search/verify.js'
import { ALL_SOURCES, DEFAULTS, resolveConfig } from '../src/settings.js'
import type { Reach } from '../src/sources/indexes.js'

const noDelay = async (): Promise<void> => {}

/** A page that answers the site scripts from a script of its own: what state it is in, and its rows. */
function fakeTab(page: { state(): string; rows?: unknown[]; box?: string }) {
  const log: string[] = []
  const tab: Tab = {
    goto: async url => { log.push(`goto ${url}`) },
    evaluate: async <T,>(expression: string): Promise<T> => {
      if (expression.includes('.focus()')) { log.push('focus'); return undefined as T }
      if (expression.includes('.click()')) { log.push('click'); return undefined as T }
      if (expression.startsWith('JSON.stringify(')) return JSON.stringify(page.rows ?? []) as T
      // The front-page script only asks whether the search box is there.
      if (expression.includes('#txt_SearchText') && !expression.includes('result-table-list')) return (page.box ?? 'results') as T
      return page.state() as T
    },
    type: async text => { log.push(`type ${text}`) },
    show: async () => { log.push('show') },
    hide: async () => { log.push('hide') },
    close: async () => {},
  }
  return { tab, log }
}

const cnkiRow: CnkiRow = { title: '迈向第三代人工智能', url: 'https://kns.cnki.net/kcms2/article/abstract?v=abc', authors: '张钹;朱军;苏航', source: '中国科学:信息科学', date: '2020-09-20', type: '期刊', cited: '1532' }

describe('reading the result rows', () => {
  it('turns a CNKI row into a paper', () => {
    expect(paperFromCnki(cnkiRow)).toEqual({ title: '迈向第三代人工智能', authors: ['张钹', '朱军', '苏航'], year: 2020, date: '2020-09-20', venue: '中国科学:信息科学', type: '期刊', url: 'https://kns.cnki.net/kcms2/article/abstract?v=abc', citations: 1532, sources: ['CNKI'] })
    expect(paperFromCnki({ ...cnkiRow, title: '某论文 网络首发', date: '2026-10-08 14:49', cited: '', url: 'javascript:void(0)' })).toMatchObject({ title: '某论文', year: 2026, date: '2026-10-08' })
    expect(paperFromCnki({ ...cnkiRow, cited: '', url: '' })).not.toHaveProperty('citations')
  })
  it('turns a Google Scholar row into a paper', () => {
    const row: ScholarRow = { title: '[PDF] Attention is all you need', url: 'https://proceedings.neurips.cc/paper/7181', meta: 'A Vaswani, N Shazeer, N Parmar… - Advances in neural …, 2017 - proceedings.neurips.cc', snippet: 'The dominant sequence transduction models', cited: 'Cited by 274507', pdf: 'https://proceedings.neurips.cc/paper/7181.pdf' }
    expect(paperFromScholar(row)).toEqual({ title: 'Attention is all you need', authors: ['A Vaswani', 'N Shazeer', 'N Parmar'], year: 2017, venue: 'Advances in neural', abstract: 'The dominant sequence transduction models', url: 'https://proceedings.neurips.cc/paper/7181', pdfUrl: 'https://proceedings.neurips.cc/paper/7181.pdf', citations: 274507, sources: ['Google Scholar'] })
    // A book entry: no link, no venue, a publisher after the year.
    expect(paperFromScholar({ title: '[BOOK][B] Deep learning', url: '', meta: 'I Goodfellow, Y Bengio - 2016 - books.google.com', snippet: '', cited: '', pdf: '' })).toEqual({ title: 'Deep learning', authors: ['I Goodfellow', 'Y Bengio'], year: 2016, sources: ['Google Scholar'] })
    expect(scholarUrl({ query: '"deep learning"', limit: 5, yearFrom: 2020 })).toBe('https://scholar.google.com/scholar?hl=en&q=%22deep+learning%22&num=10&as_ylo=2020')
  })
})

describe('searching CNKI in the browser', () => {
  it('goes through the front page like a reader and returns the rows within the years asked', async () => {
    const { tab, log } = fakeTab({ state: () => 'results', rows: [cnkiRow, { ...cnkiRow, title: '旧论文', date: '2009-01-01' }] })
    const papers = await cnkiSearch(tab, { query: '第三代人工智能', limit: 5, yearFrom: 2015 }, { delay: noDelay })
    expect(papers.map(paper => paper.title)).toEqual(['迈向第三代人工智能'])
    expect(log).toEqual(['goto https://www.cnki.net/', 'focus', 'type 第三代人工智能', 'click'])
  })
  it('asks once more when the first visit is sent to the check page, without showing the window', async () => {
    const states = ['check', 'results', 'results']
    const { tab, log } = fakeTab({ state: () => states.shift() ?? 'results', rows: [cnkiRow] })
    expect(await cnkiSearch(tab, { query: 'x', limit: 5 }, { delay: noDelay })).toHaveLength(1)
    expect(log.filter(entry => entry.startsWith('goto'))).toHaveLength(2)
    expect(log).not.toContain('show')
  })
  it('shows the window for a human check, waits for the user, and hides it again', async () => {
    const states = ['check', 'check', 'check', 'check', 'results']
    const { tab, log } = fakeTab({ state: () => states.shift() ?? 'results', rows: [cnkiRow] })
    expect(await cnkiSearch(tab, { query: 'x', limit: 5 }, { delay: noDelay })).toHaveLength(1)
    expect(log.indexOf('show')).toBeGreaterThan(-1)
    expect(log.indexOf('hide')).toBeGreaterThan(log.indexOf('show'))
    // Nothing is typed or clicked while the check is up: answering it is left to the user.
    expect(log.slice(log.indexOf('show'))).toEqual(['show', 'hide'])
  })
  it('gives up with a message for the user when nobody answers the check', async () => {
    const { tab, log } = fakeTab({ state: () => 'check' })
    await expect(cnkiSearch(tab, { query: 'x', limit: 5 }, { delay: noDelay, checkWaitMs: 3_000 })).rejects.toBeInstanceOf(HumanCheckError)
    expect(log.at(-1)).toBe('hide')
  })
  it('knows an empty result from a slow one', async () => {
    expect(await cnkiSearch(fakeTab({ state: () => 'empty' }).tab, { query: 'x', limit: 5 }, { delay: noDelay })).toEqual([])
    await expect(cnkiSearch(fakeTab({ state: () => 'loading', box: 'loading' }).tab, { query: 'x', limit: 5 }, { delay: noDelay })).rejects.toThrow(/did not show its search box/)
  })
})

describe('searching Google Scholar in the browser', () => {
  it('reads results, and says so when the network is turned away', async () => {
    const row: ScholarRow = { title: 'A paper', url: 'https://example.org/p', meta: 'A Author - Venue, 2021 - example.org', snippet: '', cited: '', pdf: '' }
    const { tab, log } = fakeTab({ state: () => 'results', rows: [row, row, row] })
    expect(await scholarSearch(tab, { query: 'a paper', limit: 2 }, { delay: noDelay })).toHaveLength(2)
    expect(log[0]).toBe('goto https://scholar.google.com/scholar?hl=en&q=a+paper&num=10')
    await expect(scholarSearch(fakeTab({ state: () => 'blocked' }).tab, { query: 'x', limit: 2 }, { delay: noDelay })).rejects.toThrow(/refusing requests/)
    expect(await scholarSearch(fakeTab({ state: () => 'empty' }).tab, { query: 'x', limit: 2 }, { delay: noDelay })).toEqual([])
  })
})

describe('choosing the browser', () => {
  const registry = (choice: string) => async (_command: string, args: string[]): Promise<string | undefined> => {
    if (args[1]!.includes('UserChoice')) return `    ProgId    REG_SZ    ${choice}\r\n`
    if (args[1]!.endsWith('chrome.exe')) return '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n'
    if (args[1]!.endsWith('msedge.exe')) return '    (Default)    REG_SZ    C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\r\n'
    return undefined
  }
  it('takes the default browser when it can be driven, else Chrome, else Edge', async () => {
    const deps = { platform: 'win32' as const, env: {}, exists: async () => true }
    expect(await findBrowser('', { ...deps, run: registry('MSEdgeHTM') })).toMatch(/msedge\.exe$/)
    expect(await findBrowser('', { ...deps, run: registry('ChromeHTML') })).toMatch(/chrome\.exe$/)
    // Firefox does not speak the protocol.
    expect(await findBrowser('', { ...deps, run: registry('FirefoxURL-308046B0AF4A39CB') })).toMatch(/chrome\.exe$/)
    expect(await findBrowser('', { ...deps, run: registry('ChromeHTML'), exists: async path => path.includes('Edge') })).toMatch(/msedge\.exe$/)
    expect(await findBrowser('', { platform: 'linux', run: async (_command, args) => (args[0] === 'chromium' ? '/usr/bin/chromium\n' : undefined), exists: async () => true })).toBe('/usr/bin/chromium')
    expect(await findBrowser('', { platform: 'darwin', run: async () => undefined, exists: async () => false })).toBeUndefined()
  })
})

describe('checking a reference no index knows', () => {
  /** Crossref, OpenAlex and arXiv all come back empty. */
  const http = createHttp(async input => {
    const url = new URL(input)
    if (url.host === 'api.crossref.org') return new Response(JSON.stringify({ message: { items: [] } }))
    if (url.host === 'api.openalex.org') return new Response(JSON.stringify({ results: [] }))
    if (url.host === 'export.arxiv.org') return new Response('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>')
    return new Response('not found', { status: 404 })
  }, noDelay)
  const browserWith = (page: Parameters<typeof fakeTab>[0]) => {
    const used: string[] = []
    const browser: WebBrowser = { pace: { delay: noDelay }, use: async job => { const { tab, log } = fakeTab(page); try { return await job(tab) } finally { used.push(...log) } }, dispose: async () => {} }
    return { browser, used }
  }
  const reach = (browser?: WebBrowser): Reach => ({ http, keys: {}, ...(browser === undefined ? {} : { browser }) })

  it('finds the title of a Chinese reference', () => {
    expect(cjkTitle('张钹, 朱军, 苏航. 迈向第三代人工智能[J]. 中国科学: 信息科学, 2020, 50(9): 1281-1302.')).toBe('迈向第三代人工智能')
    expect(cjkTitle('周志华. 机器学习[M]. 北京: 清华大学出版社, 2016.')).toBe('机器学习')
    expect(cjkTitle('李航。统计学习方法的若干进展。计算机研究与发展，2012')).toBe('统计学习方法的若干进展')
  })
  it('looks a Chinese reference up on CNKI and prefers the record that agrees', async () => {
    const digest = { ...cnkiRow, authors: '张钹', source: '科学世界', date: '2023-05-01' }
    const { browser, used } = browserWith({ state: () => 'results', rows: [digest, cnkiRow] })
    const checked = await verifyReference('张钹, 朱军, 苏航. 迈向第三代人工智能[J]. 中国科学: 信息科学, 2020, 50(9): 1281-1302.', reach(browser), { browser: 3 })
    expect(checked).toMatchObject({ verdict: 'verified', notes: [], matched: { title: '迈向第三代人工智能', year: 2020, venue: '中国科学:信息科学 · found on CNKI' } })
    expect(used).toContain('type 迈向第三代人工智能')
  })
  it('reports what differs, and what could not be found anywhere', async () => {
    const { browser } = browserWith({ state: () => 'results', rows: [cnkiRow] })
    expect(await verifyReference('李四. 迈向第三代人工智能[J]. 计算机学报, 2011.', reach(browser), { browser: 3 })).toMatchObject({ verdict: 'check', notes: ['first author "张钹" is not in the reference', 'year differs: the record says 2020'] })
    const nothing = await verifyReference('王五. 一种并不存在的想象中的梯度共振方法[J]. 计算机学报, 2021.', reach(browserWith({ state: () => 'empty' }).browser), { browser: 3 })
    expect(nothing.verdict).toBe('not_found')
    expect(nothing.notes[0]).toContain('or on CNKI')
  })
  it('sends other languages to Google Scholar, and asks nothing without a browser or a budget', async () => {
    const row: ScholarRow = { title: 'A unified theory of gradient resonance in deep nets', url: 'https://example.org/p', meta: 'W Zhang, Q Li - Journal of Examples, 2023 - example.org', snippet: '', cited: '', pdf: '' }
    const reference = 'Zhang, W. and Li, Q. (2023). A unified theory of gradient resonance in deep nets. Journal of Examples 24.'
    const { browser, used } = browserWith({ state: () => 'results', rows: [row] })
    expect(await verifyReference(reference, reach(browser), { browser: 1 })).toMatchObject({ verdict: 'verified', matched: { venue: 'Journal of Examples · found on Google Scholar' } })
    expect(used[0]).toContain('scholar.google.com/scholar?hl=en&q=%22A+unified+theory')
    expect((await verifyReference(reference, reach(), { browser: 1 })).verdict).toBe('not_found')
    const spent = browserWith({ state: () => 'results', rows: [row] })
    expect((await verifyReference(reference, reach(spent.browser), { browser: 0 })).verdict).toBe('not_found')
    expect(spent.used).toEqual([])
  })
  it('stops asking the browser once a human check went unanswered', async () => {
    const budget = { browser: 5 }
    const browser: WebBrowser = { use: async () => { throw new HumanCheckError('CNKI') }, dispose: async () => {} }
    const checked = await verifyReference('王五. 一种并不存在的想象中的梯度共振方法[J]. 计算机学报, 2021.', reach(browser), budget)
    expect(checked.notes[0]).toContain('CNKI could not be asked: CNKI asked for a human check')
    expect(budget.browser).toBe(0)
  })
})

describe('the browser settings', () => {
  it('offer the two sites without asking them by default', () => {
    expect(ALL_SOURCES).toEqual(expect.arrayContaining(['cnki', 'googlescholar']))
    expect(DEFAULTS.sources).not.toContain('cnki')
    expect(DEFAULTS.sources).not.toContain('googlescholar')
    expect(resolveConfig({})).toMatchObject({ browser: true, browserPath: '' })
    expect(resolveConfig({ browser: false, browserPath: ' "C:\\x\\chrome.exe" ', sources: ['cnki', 'nope'] })).toMatchObject({ browser: false, browserPath: 'C:\\x\\chrome.exe', sources: ['cnki'] })
  })
})
