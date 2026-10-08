/**
 * Searches run in the plugin's browser, for the two sites that matter for
 * checking a reference and have no interface for programs: CNKI (Chinese
 * journals, theses, conference papers) and Google Scholar. Each site is used
 * the way a reader uses it: CNKI through the search box on its front page,
 * Google Scholar through its search URL.
 *
 * A site may ask for a human check. The plugin does not answer it: the
 * window is put in front of the user, who has a few minutes to do so, and the
 * search carries on once the results are there. The browser keeps the site's
 * cookies, so this is seldom asked twice in a row.
 */
import { abortableDelay } from '../net/http.js'
import type { Paper } from '../search/paper.js'
import type { Tab } from './session.js'

export interface WebQuery {
  query: string
  limit: number
  yearFrom?: number
  yearTo?: number
}

export interface SiteDeps {
  delay?: typeof abortableDelay
  /** How long the user has to answer a human check. */
  checkWaitMs?: number
}

/** What the page is showing now. */
type State = 'loading' | 'results' | 'empty' | 'check' | 'blocked'

/** The site wants a human and nobody answered in time. */
export class HumanCheckError extends Error {
  constructor(site: string) {
    super(`${site} asked for a human check and it was not completed in time. A browser window was shown for it. Tell the user; once they have completed the check in that window (or if they would rather not), call again or go on without this source.`)
  }
}

async function waitFor(tab: Tab, state: string, site: string, timeoutMs: number, deps: SiteDeps, signal?: AbortSignal): Promise<State> {
  const delay = deps.delay ?? abortableDelay
  let now: State = 'loading'
  for (let waited = 0; waited < timeoutMs; waited += 500) {
    now = await tab.evaluate<State>(state).catch(() => 'loading' as State)
    if (now === 'check') return await humanCheck(tab, state, site, deps, signal)
    if (now !== 'loading') return now
    await delay(500, signal)
  }
  return now
}

/** Show the window, wait for the user to pass the check, take the window away again. */
async function humanCheck(tab: Tab, state: string, site: string, deps: SiteDeps, signal?: AbortSignal): Promise<State> {
  const delay = deps.delay ?? abortableDelay
  await tab.show()
  try {
    for (let waited = 0; waited < (deps.checkWaitMs ?? 120_000); waited += 1_000) {
      await delay(1_000, signal)
      const now = await tab.evaluate<State>(state).catch(() => 'loading' as State)
      if (now === 'results' || now === 'empty') return now
    }
    throw new HumanCheckError(site)
  } finally {
    await tab.hide()
  }
}

const yearOf = (text: string | undefined): number | undefined => { const year = Number(/\b(19|20)\d{2}\b/.exec(text ?? '')?.[0]); return Number.isFinite(year) ? year : undefined }

const inYears = (query: WebQuery) => (paper: Paper): boolean =>
  (query.yearFrom === undefined || paper.year === undefined || paper.year >= query.yearFrom) && (query.yearTo === undefined || paper.year === undefined || paper.year <= query.yearTo)

// ---------------------------------------------------------------------------------------------
// CNKI

const CNKI_HOME = 'https://www.cnki.net/'

const CNKI_STATE = `(() => {
  if (/\\/verify\\//.test(location.pathname) || /安全验证/.test(document.title)) return 'check'
  if (document.querySelector('table.result-table-list tbody tr td.name')) return 'results'
  if (/暂无数据|抱歉，暂无|没有找到/.test(document.querySelector('#gridTable, .result-con, #briefBox')?.innerText ?? '')) return 'empty'
  return 'loading'
})()`

const CNKI_BOX = `(() => {
  if (/\\/verify\\//.test(location.pathname) || /安全验证/.test(document.title)) return 'check'
  return document.querySelector('#txt_SearchText') && document.querySelector('.search-btn') ? 'results' : 'loading'
})()`

const CNKI_ROWS = `JSON.stringify([...document.querySelectorAll('table.result-table-list tbody tr')].map(row => {
  const cell = name => (row.querySelector('td.' + name)?.innerText ?? '').replace(/\\s+/g, ' ').trim()
  return { title: cell('name'), url: row.querySelector('td.name a')?.href ?? '', authors: cell('author'), source: cell('source'), date: cell('date'), type: cell('data'), cited: cell('quote') }
}))`

export interface CnkiRow { title: string; url: string; authors: string; source: string; date: string; type: string; cited: string }

export function paperFromCnki(row: CnkiRow): Paper {
  const date = /\d{4}-\d{2}-\d{2}/.exec(row.date)?.[0]
  const year = yearOf(row.date)
  const cited = Number(row.cited)
  return {
    title: row.title.replace(/\s*(网络首发|增强出版|免费)\s*$/g, '').trim(),
    authors: row.authors.split(/[;；,，]\s*/).map(author => author.trim()).filter(Boolean),
    ...(year === undefined ? {} : { year }), ...(date === undefined ? {} : { date }),
    ...(row.source === '' ? {} : { venue: row.source }), ...(row.type === '' ? {} : { type: row.type }),
    ...(row.url.startsWith('https://') ? { url: row.url } : {}),
    ...(row.cited !== '' && Number.isFinite(cited) ? { citations: cited } : {}),
    sources: ['CNKI'],
  }
}

export async function cnkiSearch(tab: Tab, query: WebQuery, deps: SiteDeps = {}, signal?: AbortSignal): Promise<Paper[]> {
  const delay = deps.delay ?? abortableDelay
  /** From the front page to a result page, at a reader's pace: the page sets itself up for a moment after loading. */
  const ask = async (): Promise<void> => {
    await tab.goto(CNKI_HOME, signal)
    if (await waitFor(tab, CNKI_BOX, 'CNKI', 20_000, deps, signal) !== 'results') throw new Error('CNKI did not show its search box (the site may be unreachable from this network).')
    await delay(2_500, signal)
    await tab.evaluate('document.querySelector("#txt_SearchText").focus()')
    await tab.type(query.query)
    await delay(600, signal)
    await tab.evaluate('document.querySelector(".search-btn").click()')
    await delay(1_500, signal)
  }
  await ask()
  // A first visit with a new profile is often sent to the check page before the site has set its cookies;
  // the same search made again from the front page then goes through. Asked twice, the user is shown the window.
  if (await tab.evaluate<State>(CNKI_STATE).catch(() => 'loading' as State) === 'check') {
    await delay(2_000, signal)
    await ask()
  }
  const state = await waitFor(tab, CNKI_STATE, 'CNKI', 30_000, deps, signal)
  if (state === 'empty') return []
  if (state !== 'results') throw new Error('CNKI did not show results in time.')
  const rows = JSON.parse(await tab.evaluate<string>(CNKI_ROWS)) as CnkiRow[]
  return rows.filter(row => row.title !== '').map(paperFromCnki).filter(inYears(query)).slice(0, query.limit)
}

// ---------------------------------------------------------------------------------------------
// Google Scholar

const SCHOLAR_STATE = `(() => {
  if (location.pathname.startsWith('/sorry') || document.querySelector('#gs_captcha_ccl, #recaptcha, .g-recaptcha, form[action*="sorry"]')) return 'check'
  if (document.querySelector('#gs_res_ccl .gs_r .gs_rt, #gs_res_ccl_mid .gs_r .gs_rt')) return 'results'
  const text = document.body?.innerText ?? ''
  if (/unusual traffic|异常流量|automated queries/i.test(text)) return 'blocked'
  if (/did not match any articles|未找到.*相符|找不到和您查询/.test(text)) return 'empty'
  return document.readyState === 'complete' && document.querySelector('#gs_res_ccl, #gs_ccl') ? 'empty' : 'loading'
})()`

const SCHOLAR_ROWS = `JSON.stringify([...document.querySelectorAll('#gs_res_ccl_mid .gs_r.gs_or, #gs_res_ccl .gs_r.gs_or')].map(row => ({
  title: row.querySelector('.gs_rt')?.innerText ?? '', url: row.querySelector('.gs_rt a')?.href ?? '', meta: row.querySelector('.gs_a')?.innerText ?? '',
  snippet: (row.querySelector('.gs_rs')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
  cited: [...row.querySelectorAll('.gs_fl a')].map(link => link.innerText).find(text => /^Cited by|^被引用/.test(text)) ?? '',
  pdf: row.querySelector('.gs_or_ggsm a')?.href ?? '',
})))`

export interface ScholarRow { title: string; url: string; meta: string; snippet: string; cited: string; pdf: string }

export function paperFromScholar(row: ScholarRow): Paper {
  // "A Vaswani, N Shazeer… - Advances in neural …, 2017 - proceedings.neurips.cc"
  const parts = row.meta.replace(/ /g, ' ').split(/\s+-\s+/)
  const middle = parts.length > 2 ? parts.slice(1, -1).join(' - ') : parts[1] ?? ''
  const year = yearOf(middle) ?? yearOf(row.meta)
  const venue = middle.replace(/,?\s*\b(19|20)\d{2}\b\s*$/, '').replace(/…/g, '').trim()
  const cited = Number(/\d+/.exec(row.cited)?.[0])
  const isPdf = /\.pdf(\?|$)/i.test(row.pdf) || /^\s*\[PDF\]/i.test(row.title)
  return {
    title: row.title.replace(/^(\s*\[[^\]]{1,12}\])+\s*/g, '').replace(/\s+/g, ' ').trim(),
    authors: (parts[0] ?? '').replace(/…/g, '').split(',').map(author => author.trim()).filter(Boolean),
    ...(year === undefined ? {} : { year }), ...(venue === '' ? {} : { venue }),
    ...(row.snippet === '' ? {} : { abstract: row.snippet }),
    ...(row.url.startsWith('http') ? { url: row.url } : {}),
    ...(row.pdf.startsWith('http') && isPdf ? { pdfUrl: row.pdf } : {}),
    ...(Number.isFinite(cited) ? { citations: cited } : {}),
    sources: ['Google Scholar'],
  }
}

export function scholarUrl(query: WebQuery): string {
  const params = new URLSearchParams({ hl: 'en', q: query.query, num: String(Math.min(20, Math.max(10, query.limit))) })
  if (query.yearFrom !== undefined) params.set('as_ylo', String(query.yearFrom))
  if (query.yearTo !== undefined) params.set('as_yhi', String(query.yearTo))
  return `https://scholar.google.com/scholar?${params.toString()}`
}

export async function scholarSearch(tab: Tab, query: WebQuery, deps: SiteDeps = {}, signal?: AbortSignal): Promise<Paper[]> {
  await tab.goto(scholarUrl(query), signal)
  const state = await waitFor(tab, SCHOLAR_STATE, 'Google Scholar', 25_000, deps, signal)
  if (state === 'empty') return []
  if (state === 'blocked') throw new Error('Google Scholar is refusing requests from this network for now (too many, or the address is on its list). Try again later or go on without it.')
  if (state !== 'results') throw new Error('Google Scholar did not show results in time (it may be unreachable from this network without a proxy).')
  const rows = JSON.parse(await tab.evaluate<string>(SCHOLAR_ROWS)) as ScholarRow[]
  return rows.filter(row => row.title.trim() !== '').map(paperFromScholar).slice(0, query.limit)
}
