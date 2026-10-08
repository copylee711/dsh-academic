// Live run of the browser sources (opens a Chrome / Edge window off screen; network).
// Usage: pnpm run build && node scripts/browser-smoke.mjs ["中文检索词"] ["english query"]
// If a site asks for a human check, the window comes on screen and waits for you; the script does not answer it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBrowser } from '../lib/types/browser/find.js'
import { createBrowserSession } from '../lib/types/browser/session.js'
import { pdfText } from '../lib/types/fulltext/pdf.js'
import { TextCache } from '../lib/types/fulltext/resolve.js'
import { createHttp } from '../lib/types/net/http.js'
import { createPaperTools } from '../lib/types/search/tools.js'
import { DEFAULTS } from '../lib/types/settings.js'

const chinese = process.argv[2] ?? '注意力机制 图像分类'
const english = process.argv[3] ?? 'attention is all you need'
console.log('browser:', await findBrowser(''))
const browser = createBrowserSession({ program: () => findBrowser(''), profileDir: process.env.DSH_BROWSER_PROFILE ?? join(mkdtempSync(join(tmpdir(), 'dsh-academic-')), 'browser') })
const tools = createPaperTools({ settings: () => DEFAULTS, http: createHttp(), pdfText, cache: new TextCache(undefined), browser })
const run = async (name, args, max = 1800) => {
  console.log(`\n=== ${name} ${JSON.stringify(args)}`)
  const started = Date.now()
  try {
    const { text } = await tools.find(tool => tool.name === name).execute(args, { signal: new AbortController().signal })
    console.log(`${text.length > max ? `${text.slice(0, max)}\n… (${text.length} chars)` : text}\n(${Date.now() - started} ms)`)
  } catch (error) {
    console.log(`ERROR: ${error.message} (${Date.now() - started} ms)`)
  }
}
try {
  await run('paper_search', { query: chinese, sources: ['cnki'], limit: 5, abstract: 'none' })
  await run('paper_search', { query: english, sources: ['googlescholar'], limit: 5 })
  await run('reference_verify', { references: [
    '何恺明, 张祥雨, 任少卿, 等. 深度残差学习在图像识别中的应用[J]. 计算机学报, 2016.',
    '周志华. 机器学习[M]. 北京: 清华大学出版社, 2016.',
    '张钹, 朱军, 苏航. 迈向第三代人工智能[J]. 中国科学: 信息科学, 2020, 50(9): 1281-1302.',
    'Zhang, W. and Li, Q. (2023). A unified theory of imaginary gradient resonance in deep nets. Journal of Machine Learning Research 24.',
  ] }, 3000)
} finally {
  await browser.dispose()
}
