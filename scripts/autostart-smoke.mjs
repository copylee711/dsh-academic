// Live run of the auto-start: with Zotero closed, one read-only request must start it (minimized) and get an answer.
// Usage: pnpm run build && node scripts/autostart-smoke.mjs      (starts the Zotero on this computer; changes nothing in it)
import { DEFAULTS } from '../lib/types/settings.js'
import { ZoteroClient } from '../lib/types/zotero/client.js'
import { createLauncher, findZotero } from '../lib/types/zotero/launch.js'

console.log('Zotero program:', await findZotero(''))
const client = new ZoteroClient(() => DEFAULTS.zoteroBaseUrl, undefined, undefined, {
  source: () => 'local',
  launcher: createLauncher({ enabled: () => true, path: () => '' }),
})
console.log('before:', JSON.stringify(await client.probe()))
const started = Date.now()
try {
  const page = await client.json('users/0/items/top', { limit: 1 })
  console.log(`answered by ${client.via} after ${String(Date.now() - started)} ms; Zotero ${client.version ?? '?'}; ${String(page.total)} top-level items`)
} catch (error) {
  console.log(`failed after ${String(Date.now() - started)} ms: ${error.message}`)
}
