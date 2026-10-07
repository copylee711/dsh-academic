// Read-only run of the Zotero tools against the Zotero on this computer.
// Usage: pnpm run build && node scripts/zotero-smoke.mjs ["query"]
import { ZoteroClient } from '../lib/types/zotero/client.js'
import { createReadTools } from '../lib/types/zotero/tools.js'
import { DEFAULTS } from '../lib/types/settings.js'

const query = process.argv[2] ?? ''
const client = new ZoteroClient(() => DEFAULTS.zoteroBaseUrl)
const tools = createReadTools({ client, settings: () => DEFAULTS })
const exec = { signal: new AbortController().signal }
const run = async (name, args) => {
  console.log(`\n=== ${name} ${JSON.stringify(args)}`)
  try {
    const { text } = await tools.find(tool => tool.name === name).execute(args, exec)
    console.log(text.length > 1800 ? `${text.slice(0, 1800)}\n… (${text.length} chars)` : text)
    return text
  } catch (error) {
    console.log(`ERROR: ${error.message}`)
    return ''
  }
}

console.log('probe', await client.probe())
await run('zotero_browse', { kind: 'libraries' })
await run('zotero_browse', { kind: 'collections' })
await run('zotero_browse', { kind: 'tags', limit: 10 })
const hits = await run('zotero_search', { query, limit: 5 })
if (query) await run('zotero_search', { query, mode: 'everything', limit: 5 })
const ref = /zotero:\/\/\S+\/item\/[A-Z0-9]{8}/.exec(hits)?.[0]
if (ref) {
  await run('zotero_get', { ref })
  await run('zotero_attachment', { ref })
  await run('zotero_read', { ref, max_chars: 1200 })
  await run('zotero_read', { ref, query: query || 'method results', passages: 2 })
  await run('zotero_export', { refs: [ref], format: 'bibtex' })
  await run('zotero_export', { refs: [ref], format: 'bibliography', style: 'apa' })
  await run('zotero_export', { refs: [ref], format: 'citation' })
}
