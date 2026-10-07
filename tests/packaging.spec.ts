import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.js'
import { promptText } from '../src/prompt.js'
import { DEFAULTS, ENTRY_ID, resolveConfig } from '../src/settings.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; files: string[]; dependencies?: Record<string, string>; publishConfig?: { access?: string } }

describe('packaging', () => {
  it('publishes publicly under the plugin name, with the settings namespace the code uses', () => {
    expect(pkg.name).toBe(name)
    expect(pkg.publishConfig?.access).toBe('public')
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain(`name: '${pkg.name}'`)
    expect(patch).toContain(`id: ${ENTRY_ID}`)
  })
  it('needs nothing installed beside it: libraries are bundled', () => {
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.files).toContain('lib/*.js')
  })
  it('declares a default for every setting', () => {
    expect(resolveConfig(new Config({}))).toEqual(DEFAULTS)
  })
})

const lib = new URL('../lib/', import.meta.url)

describe('built bundles', () => {
  it.skipIf(!existsSync(new URL('client.js', lib)))('registers the client under the package name', () => {
    expect(readFileSync(new URL('client.js', lib), 'utf8').slice(0, 200)).toContain(`id: "${pkg.name}"`)
  })
  it.skipIf(!existsSync(new URL('index.js', lib)))('ships every chunk the host bundle loads', () => {
    const files = new Set(readdirSync(lib))
    const host = readFileSync(new URL('index.js', lib), 'utf8')
    // The bundler writes its own chunk imports with double quotes; single-quoted ones are type comments of bundled libraries.
    const chunks = [...host.matchAll(/\bimport\("\.\/([^"]+)"\)/g)].map(match => match[1]!)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) expect(files.has(chunk)).toBe(true)
  })
})

describe('system prompt', () => {
  it('tells the model whether it may change the library', () => {
    expect(promptText(DEFAULTS)).toContain('read-only')
    expect(promptText({ ...DEFAULTS, zoteroWrite: true })).toContain('zotero_add')
    expect(promptText({ ...DEFAULTS, zotero: false, papers: false })).toBe('')
  })
})
