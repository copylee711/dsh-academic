// Live run of paper_search sorted by date (network): the newest papers must be on the topic and not dated in the future.
// Usage: pnpm run build && node scripts/date-smoke.mjs ["query"]
import { createHttp } from '../lib/types/net/http.js'
import { createPaperTools } from '../lib/types/search/tools.js'
import { pdfText } from '../lib/types/fulltext/pdf.js'
import { TextCache } from '../lib/types/fulltext/resolve.js'
import { DEFAULTS } from '../lib/types/settings.js'

const query = process.argv[2] ?? 'deep learning'
const tools = createPaperTools({ settings: () => DEFAULTS, http: createHttp(), pdfText, cache: new TextCache(undefined) })
const search = tools.find(tool => tool.name === 'paper_search')
for (const args of [{ query, sort: 'date', year_from: new Date().getFullYear(), limit: 10, abstract: 'none' }, { query, sort: 'date', limit: 8, abstract: 'none' }]) {
  console.log(`\n=== ${JSON.stringify(args)}`)
  const { text, papers } = await search.execute(args, { signal: new AbortController().signal })
  console.log(text)
  const years = (papers ?? []).map(paper => paper.year)
  console.log(`years: ${years.join(', ')}; any in the future: ${String(years.some(year => year > new Date().getFullYear() + 1))}`)
}
