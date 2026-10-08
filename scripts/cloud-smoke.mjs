// Live run of the Zotero tools against zotero.org only (network), with the key in ZOTERO_API_KEY.
// Usage: pnpm run build && node scripts/cloud-smoke.mjs ["query"] [--write]
// Read-only unless --write is given; --write adds one note tagged dsh-academic-test.
import { createHttp } from '../lib/types/net/http.js'
import { DEFAULTS } from '../lib/types/settings.js'
import { ZoteroWriter } from '../lib/types/zotero/auth.js'
import { ZoteroClient } from '../lib/types/zotero/client.js'
import { createReadTools } from '../lib/types/zotero/tools.js'
import { createWriteTools } from '../lib/types/zotero/write-tools.js'

const key = process.env.ZOTERO_API_KEY ?? ''
if (key === '') { console.log('ZOTERO_API_KEY is not set.'); process.exit(1) }
const query = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'attention'
const settings = () => ({ ...DEFAULTS, zoteroSource: 'cloud', zoteroApiKey: key, zoteroWrite: true })
const client = new ZoteroClient(() => DEFAULTS.zoteroBaseUrl, undefined, undefined, { source: () => 'cloud', cloudKey: () => key })
const host = { client, settings }
const tools = [...createReadTools(host), ...createWriteTools({ ...host, writer: new ZoteroWriter(client, { load: async () => undefined, save: async () => {} }), http: createHttp() })]
const run = async (name, args, max = 1400) => {
  console.log(`\n=== ${name} ${JSON.stringify(args)}`)
  const started = Date.now()
  try {
    const { text } = await tools.find(tool => tool.name === name).execute(args, { signal: new AbortController().signal })
    console.log(`${text.length > max ? `${text.slice(0, max)}\n… (${text.length} chars)` : text}\n(${Date.now() - started} ms)`)
    return text
  } catch (error) {
    console.log(`ERROR: ${error.message} (${Date.now() - started} ms)`)
    return ''
  }
}

const account = await client.cloudAccount()
console.log(`key of ${account.username}: library=${account.library} write=${account.write} files=${account.files}`)
await run('zotero_browse', { kind: 'libraries' })
await run('zotero_browse', { kind: 'collections' })
await run('zotero_browse', { kind: 'tags', limit: 10 })
const found = await run('zotero_search', { query, limit: 5 })
await run('zotero_search', { query, mode: 'everything', limit: 5 })
const ref = /zotero:\/\/user\/0\/item\/[A-Z0-9]{8}/.exec(found)?.[0]
if (ref) {
  await run('zotero_get', { ref })
  await run('zotero_read', { ref, query: 'attention', passages: 2 })
  await run('zotero_read', { ref, max_chars: 600 }, 900)
  await run('zotero_export', { refs: [ref], format: 'bibtex' })
  await run('zotero_export', { refs: [ref], format: 'bibliography', style: 'china-national-standard-gb-t-7714-2015-numeric' })
  await run('zotero_attachment', { ref })
}
if (process.argv.includes('--write')) {
  await run('zotero_note', { markdown: '**dsh-academic 0.4.0** cloud write test. Safe to delete.', tags: ['dsh-academic-test'] })
}
