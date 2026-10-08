import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { credentialKeyStore, fileKeyStore, hasRecordApi, Keys, layeredKeyStore, validKey, type CredentialRecords, type KeyStore } from '../src/keys.js'
import { DEFAULTS, resolveConfig } from '../src/settings.js'
import { itemFromCsl } from '../src/zotero/csl.js'
import { creatorSummary } from '../src/zotero/format.js'
import { item } from './helpers.js'

const ZOTERO = 'abcdefghijklmnopqrstuvwx'

/** DSH's credential records, in memory. */
function fakeCredentials(refuse = false) {
  const records = new Map<string, { kind: string; key?: string }>()
  const service: CredentialRecords = {
    readRecord: async key => { if (refuse) throw new Error('unknown scope'); return records.get(key) },
    modifyRecord: async (key, mutate) => {
      if (refuse) throw new Error('unknown scope')
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return next
    },
    deleteRecord: async key => { records.delete(key) },
  }
  return { service, records }
}

function memoryStore(): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: async name => data.get(name), set: async (name, value) => { data.set(name, value) }, unset: async name => { data.delete(name) } }
}

describe('where the keys are kept', () => {
  it('is the credential store, under the plugin\'s own scope', async () => {
    const { service, records } = fakeCredentials()
    expect(hasRecordApi(service)).toBe(true)
    expect(hasRecordApi({ resolve: async () => '' })).toBe(false)
    const store = credentialKeyStore(service)
    await store.set('zotero', ZOTERO)
    expect([...records]).toEqual([['copylee-academic/zotero', { kind: 'api-key', key: ZOTERO }]])
    expect(await store.get('zotero')).toBe(ZOTERO)
    expect(await store.get('s2')).toBeUndefined()
    await store.unset('zotero')
    expect(records.size).toBe(0)
  })
  it('is a private file on a host without that store, or when the store refuses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'academic-keys-'))
    try {
      const file = fileKeyStore(dir)
      await file.set('s2', 'semantic-scholar-key')
      expect(JSON.parse(await readFile(join(dir, 'keys.json'), 'utf8'))).toEqual({ s2: 'semantic-scholar-key' })
      // Unix permission bits; Windows reports its own.
      if (process.platform !== 'win32') expect((await stat(join(dir, 'keys.json'))).mode & 0o777).toBe(0o600)
      const layered = layeredKeyStore(credentialKeyStore(fakeCredentials(true).service), file)
      await layered.set('ncbi', 'ncbi-key-12345')
      expect(await layered.get('ncbi')).toBe('ncbi-key-12345')
      expect(await file.get('ncbi')).toBe('ncbi-key-12345')
      // Once the credential store takes a key, the copy in the file goes.
      const good = fakeCredentials()
      await layeredKeyStore(credentialKeyStore(good.service), file).set('s2', 'semantic-scholar-key-2')
      expect(await file.get('s2')).toBeUndefined()
      expect(good.records.get('copylee-academic/s2')?.key).toBe('semantic-scholar-key-2')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the keys as the tools see them', () => {
  it('stand in the settings fields without being written there', async () => {
    const store = memoryStore()
    const keys = new Keys(store)
    await keys.load()
    expect(keys.apply(DEFAULTS).zoteroApiKey).toBe('')
    await keys.set('zotero', ` ${ZOTERO} `)
    expect(keys.apply(DEFAULTS)).toMatchObject({ zoteroApiKey: ZOTERO, s2Key: '' })
    expect(keys.configured()).toEqual({ zotero: true, s2: false, openalex: false, ncbi: false })
    // What the settings page is told has no key in it.
    expect(JSON.stringify(keys.configured())).not.toContain(ZOTERO)
    await keys.unset('zotero')
    expect(keys.apply(DEFAULTS).zoteroApiKey).toBe('')
    expect(store.data.size).toBe(0)
  })
  it('refuses what cannot be a key', async () => {
    const keys = new Keys(memoryStore())
    await expect(keys.set('zotero', 'too short')).rejects.toThrow(/does not look like an API key/)
    await expect(keys.set('s2', 'has a space in it')).rejects.toThrow()
    expect(validKey('zotero', ZOTERO)).toBe(true)
    expect(validKey('openalex', 'oa_live-Key.123')).toBe(true)
  })
  it('are read again from the credential store when it arrives', async () => {
    const file = memoryStore()
    file.data.set('s2', 'from-the-file-1')
    const keys = new Keys(file)
    await keys.load()
    expect(keys.get('s2')).toBe('from-the-file-1')
    const credentials = memoryStore()
    credentials.data.set('zotero', ZOTERO)
    await keys.use(layeredKeyStore(credentials, file))
    expect(keys.configured()).toMatchObject({ zotero: true, s2: true })
  })
})

describe('keys an earlier version left in the settings', () => {
  it('are moved into the store, and their settings fields named for removal', async () => {
    const store = memoryStore()
    const keys = new Keys(store)
    await keys.load()
    const old = resolveConfig({ zoteroApiKey: ZOTERO, s2Key: 'semantic-scholar-key', ncbiKey: '' })
    expect(await keys.adopt(old)).toEqual(['zoteroApiKey', 's2Key'])
    expect(store.data.get('zotero')).toBe(ZOTERO)
    expect(keys.get('s2')).toBe('semantic-scholar-key')
    // Nothing left to move the next time round.
    expect(await keys.adopt(resolveConfig({}))).toEqual([])
  })
  it('do not replace a key set since, and stay put when they could not be stored', async () => {
    const store = memoryStore()
    const keys = new Keys(store)
    await keys.set('zotero', 'zyxwvutsrqponmlkjihgfedc')
    expect(await keys.adopt(resolveConfig({ zoteroApiKey: ZOTERO }))).toEqual(['zoteroApiKey'])
    expect(keys.get('zotero')).toBe('zyxwvutsrqponmlkjihgfedc')
    const broken: KeyStore = { get: async () => undefined, set: async () => { throw new Error('disk full') }, unset: async () => {} }
    expect(await new Keys(broken).adopt(resolveConfig({ zoteroApiKey: ZOTERO }))).toEqual([])
  })
})

describe('what a first real session showed', () => {
  it('drops the heading publishers deposit with an abstract', () => {
    const made = itemFromCsl({ type: 'journal-article', title: ['T'], abstract: '<jats:title>Abstract</jats:title><jats:p>General reasoning is hard.</jats:p>' }, '10.1000/x')
    expect(made.abstractNote).toBe('General reasoning is hard.')
    expect(itemFromCsl({ type: 'journal-article', title: ['T'], abstract: '<jats:p>Abstract General reasoning is hard.</jats:p>' }, '10.1000/x').abstractNote).toBe('General reasoning is hard.')
    // A sentence that merely begins with the word is left alone.
    expect(itemFromCsl({ type: 'journal-article', title: ['T'], abstract: 'Abstract algebra is the study of structures.' }, '10.1000/x').abstractNote).toBe('Abstract algebra is the study of structures.')
  })
  it('shows author names without Zotero\'s invisible direction marks', () => {
    expect(creatorSummary(item('PAPER001', {}, { meta: { creatorSummary: '⁨Gu⁩和⁨Dao⁩' } }))).toBe('Gu和Dao')
  })
})
