// Live run of the paper tools against the real indexes (network).
// Usage: pnpm run build && node scripts/search-smoke.mjs ["query"] ["arxiv,openalex"]
import { createHttp } from '../lib/types/net/http.js'
import { createPaperTools } from '../lib/types/search/tools.js'
import { pdfText } from '../lib/types/fulltext/pdf.js'
import { TextCache } from '../lib/types/fulltext/resolve.js'
import { DEFAULTS } from '../lib/types/settings.js'

const query = process.argv[2] ?? 'attention is all you need transformer'
const sources = process.argv[3]?.split(',')
const tools = createPaperTools({ settings: () => DEFAULTS, http: createHttp(), pdfText, cache: new TextCache(undefined) })
const run = async (name, args, max = 1600) => {
  console.log(`\n=== ${name} ${JSON.stringify(args)}`)
  const started = Date.now()
  try {
    const { text } = await tools.find(tool => tool.name === name).execute(args, { signal: new AbortController().signal })
    console.log(`${text.length > max ? `${text.slice(0, max)}\n… (${text.length} chars)` : text}\n(${Date.now() - started} ms)`)
  } catch (error) {
    console.log(`ERROR: ${error.message} (${Date.now() - started} ms)`)
  }
}

await run('paper_search', { query, limit: 5, ...(sources ? { sources } : {}) })
await run('paper_get', { id: 'arXiv:1706.03762' })
await run('paper_get', { id: '10.1038/nature14539' }, 900)
await run('paper_citations', { id: '10.1038/nature14539', direction: 'citations', limit: 3 }, 900)
await run('paper_read', { id: '2010.11929', outline: true })
await run('paper_read', { id: '2010.11929', section: 'Method', max_chars: 1200 })
await run('paper_read', { id: '1706.03762', query: 'positional encoding sinusoid', passages: 2 })
await run('paper_read', { id: '10.1371/journal.pone.0185809', outline: true }, 900)
await run('paper_read', { id: '10.1038/nature14539', max_chars: 600 }, 900)
await run('paper_cite', { ids: ['10.1038/nature14539', '1706.03762', '10.9999/does-not-exist'], format: 'bibtex' })
await run('paper_cite', { ids: ['10.1038/nature14539'], format: 'text', style: 'ieee' })
await run('reference_verify', { references: [
  'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436-444. https://doi.org/10.1038/nature14539',
  'Vaswani, A. et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems 30.',
  'Smith, J. (2021). Quantum gravity in transformer networks. Nature, 590, 1-9. https://doi.org/10.1038/nature14539',
  'Zhang, W. and Li, Q. (2023). A unified theory of imaginary gradient resonance in deep nets. Journal of Machine Learning Research 24.',
  'Wakefield AJ et al. (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet 351:637-41. doi:10.1016/S0140-6736(97)11096-0',
] }, 3000)
