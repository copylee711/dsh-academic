/**
 * Plugin settings shared by the host and the settings page: defaults and the
 * tolerant reader for the Loader entry config. No schemastery here so the
 * browser bundle stays small.
 */

/** The Loader entry id (settings namespace); see cordis.patch.yml. */
export const ENTRY_ID = 'copylee-academic'

/**
 * Every index paper_search can ask. Off by default: DBLP (it turns away non-browser clients on some
 * networks), and CNKI and Google Scholar (searched through a browser window, so slower and at times
 * interrupted by a human check; the model names them when it needs them).
 */
export const ALL_SOURCES = ['arxiv', 'openalex', 'crossref', 'semanticscholar', 'pubmed', 'europepmc', 'dblp', 'cnki', 'googlescholar']

export const DEFAULT_ZOTERO_URL = 'http://127.0.0.1:23119'

/** Where the Zotero tools read the library: this computer, zotero.org, or this computer first. */
export const ZOTERO_SOURCES = ['auto', 'local', 'cloud'] as const
export type ZoteroSource = typeof ZOTERO_SOURCES[number]

export interface Settings {
  /** Register the Zotero tools at all. */
  zotero: boolean
  /** auto: the Zotero on this computer, and zotero.org when it cannot be reached and a key is set. */
  zoteroSource: ZoteroSource
  /** API key for zotero.org (zotero.org/settings/keys); empty means the online library is not used. */
  zoteroApiKey: string
  /** Start Zotero when a tool needs it and it is not running. */
  zoteroAutoStart: boolean
  /** Path of the Zotero program, when it is not where the system says. */
  zoteroPath: string
  /** Where Zotero's local server listens. Loopback only. */
  zoteroBaseUrl: string
  /** `user` for the personal library, or a numeric group id. */
  zoteroLibrary: string
  /** Offer the tools that change the library (needs Zotero 10 or later). */
  zoteroWrite: boolean
  /** CSL style id for formatted citations, as installed in Zotero. */
  citationStyle: string
  /** Register the paper search and reading tools. */
  papers: boolean
  /** The indexes paper_search asks when the model names none. */
  sources: string[]
  /** Contact address sent to Crossref, OpenAlex, NCBI, Europe PMC and Unpaywall, which ask for one. */
  email: string
  /** Let the plugin drive a Chrome or Edge window of its own to search CNKI and Google Scholar. */
  browser: boolean
  /** Path of the browser program, when it is not found by itself. */
  browserPath: string
  /** Optional keys; every index works without. */
  s2Key: string
  openalexKey: string
  ncbiKey: string
  /** Most rows a search or a listing returns in one call. */
  maxResults: number
  /** Most characters of a paper's text one call returns. */
  maxContentChars: number
  /** Offer the bundled academic skills. */
  skills: boolean
  /** Names of bundled skills the user switched off. */
  disabledSkills: string[]
}

export const DEFAULTS: Settings = {
  zotero: true,
  zoteroSource: 'auto',
  zoteroApiKey: '',
  zoteroAutoStart: true,
  zoteroPath: '',
  zoteroBaseUrl: DEFAULT_ZOTERO_URL,
  zoteroLibrary: 'user',
  zoteroWrite: false,
  citationStyle: 'apa',
  papers: true,
  sources: ['arxiv', 'openalex', 'crossref', 'semanticscholar', 'pubmed', 'europepmc'],
  browser: true,
  browserPath: '',
  email: '',
  s2Key: '',
  openalexKey: '',
  ncbiKey: '',
  maxResults: 20,
  maxContentChars: 12_000,
  skills: true,
  disabledSkills: [],
}

/** Zotero's server is only ever reached on this computer; anything else falls back to the default. */
export function loopbackUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ZOTERO_URL
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'http:' || !(host === '127.0.0.1' || host === 'localhost' || host === '[::1]')) return DEFAULT_ZOTERO_URL
    return url.origin
  } catch {
    return DEFAULT_ZOTERO_URL
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/** Unwrap `.volatile()` refs (`{ get() }`) and fall back to defaults for bad values. */
export function resolveConfig(raw: unknown): Settings {
  const out: Record<string, unknown> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get: () => unknown }).get()
        : value
    }
  }
  const library = typeof out.zoteroLibrary === 'string' ? out.zoteroLibrary.trim() : ''
  const style = typeof out.citationStyle === 'string' ? out.citationStyle.trim() : ''
  const text = (key: string): string => (typeof out[key] === 'string' ? (out[key] as string).trim() : '')
  const sources = Array.isArray(out.sources) ? out.sources.filter((source): source is string => typeof source === 'string' && ALL_SOURCES.includes(source)) : undefined
  return {
    papers: typeof out.papers === 'boolean' ? out.papers : DEFAULTS.papers,
    sources: sources === undefined ? DEFAULTS.sources : [...new Set(sources)],
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text('email')) ? text('email') : '',
    browser: typeof out.browser === 'boolean' ? out.browser : DEFAULTS.browser,
    browserPath: text('browserPath').replace(/^"(.*)"$/, '$1'),
    s2Key: text('s2Key'),
    openalexKey: text('openalexKey'),
    ncbiKey: text('ncbiKey'),
    zotero: typeof out.zotero === 'boolean' ? out.zotero : DEFAULTS.zotero,
    zoteroSource: (ZOTERO_SOURCES as readonly unknown[]).includes(out.zoteroSource) ? out.zoteroSource as ZoteroSource : DEFAULTS.zoteroSource,
    zoteroApiKey: /^[A-Za-z0-9]{16,64}$/.test(text('zoteroApiKey')) ? text('zoteroApiKey') : '',
    zoteroAutoStart: typeof out.zoteroAutoStart === 'boolean' ? out.zoteroAutoStart : DEFAULTS.zoteroAutoStart,
    zoteroPath: text('zoteroPath').replace(/^"(.*)"$/, '$1'),
    zoteroBaseUrl: loopbackUrl(out.zoteroBaseUrl),
    zoteroLibrary: /^\d+$/.test(library) ? library : DEFAULTS.zoteroLibrary,
    zoteroWrite: typeof out.zoteroWrite === 'boolean' ? out.zoteroWrite : DEFAULTS.zoteroWrite,
    citationStyle: /^[\w.-]+$/.test(style) ? style : DEFAULTS.citationStyle,
    maxResults: clamp(out.maxResults, 1, 100, DEFAULTS.maxResults),
    maxContentChars: clamp(out.maxContentChars, 2_000, 100_000, DEFAULTS.maxContentChars),
    skills: typeof out.skills === 'boolean' ? out.skills : DEFAULTS.skills,
    disabledSkills: Array.isArray(out.disabledSkills) ? [...new Set(out.disabledSkills.filter((name): name is string => typeof name === 'string' && /^[a-z0-9-]+$/.test(name)))] : [],
  }
}
