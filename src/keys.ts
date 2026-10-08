/**
 * The API keys the user gives the plugin (zotero.org, Semantic Scholar,
 * OpenAlex, NCBI). They are kept in DSH's credential store as records
 * `copylee-academic/<name>`, or in a private file beside the plugin's data on
 * hosts without that store; never in the plugin's settings, because a profile
 * backup or a shared `cordis.patch.yml` carries the settings as they are.
 * Keys are read on the host only; the settings page learns which are set.
 */
import { join } from 'node:path'
import { ENTRY_ID, type Settings } from './settings.js'
import { Mutex, readJson, writeJson } from './storage.js'

export const KEY_NAMES = ['zotero', 's2', 'openalex', 'ncbi'] as const
export type KeyName = typeof KEY_NAMES[number]

/** The settings field each key used to live in, and still reaches the tools through. */
export const KEY_FIELDS: Record<KeyName, 'zoteroApiKey' | 's2Key' | 'openalexKey' | 'ncbiKey'> = { zotero: 'zoteroApiKey', s2: 's2Key', openalex: 'openalexKey', ncbi: 'ncbiKey' }

export const isKeyName = (value: unknown): value is KeyName => (KEY_NAMES as readonly unknown[]).includes(value)

/** What a key may look like; anything else is a paste gone wrong. */
export function validKey(name: KeyName, value: string): boolean {
  return name === 'zotero' ? /^[A-Za-z0-9]{16,64}$/.test(value) : /^[\x21-\x7e]{8,200}$/.test(value)
}

export interface KeyStore {
  get(name: KeyName): Promise<string | undefined>
  set(name: KeyName, value: string): Promise<void>
  unset(name: KeyName): Promise<void>
}

interface ApiKeyRecord { kind: string; key?: string }

/** The part of DSH's credentials service used here. A record key is the string `<scope>/<id>`. */
export interface CredentialRecords {
  readRecord(key: never): Promise<ApiKeyRecord | undefined>
  modifyRecord(key: never, mutate: (current: ApiKeyRecord | undefined) => Promise<ApiKeyRecord | undefined>): Promise<unknown>
  deleteRecord(key: never): Promise<void>
}

export function hasRecordApi(value: unknown): value is CredentialRecords {
  const candidate = value as Partial<CredentialRecords> | null | undefined
  return typeof candidate?.readRecord === 'function' && typeof candidate.modifyRecord === 'function' && typeof candidate.deleteRecord === 'function'
}

const recordKey = (name: KeyName): never => `${ENTRY_ID}/${name}` as never

export function credentialKeyStore(service: CredentialRecords): KeyStore {
  return {
    async get(name) {
      const record = await service.readRecord(recordKey(name))
      const key = record?.kind === 'api-key' ? record.key?.trim() : undefined
      return key ? key : undefined
    },
    async set(name, value) { await service.modifyRecord(recordKey(name), async () => ({ kind: 'api-key', key: value })) },
    async unset(name) { await service.deleteRecord(recordKey(name)) },
  }
}

export function fileKeyStore(dir: string): KeyStore {
  const path = join(dir, 'keys.json')
  const mutex = new Mutex()
  const load = async (): Promise<Partial<Record<KeyName, string>>> => {
    const raw = await readJson(path)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter((pair): pair is [KeyName, string] => isKeyName(pair[0]) && typeof pair[1] === 'string' && pair[1] !== ''))
  }
  return {
    async get(name) { return (await load())[name] },
    set(name, value) { return mutex.run(async () => { await writeJson(path, { ...(await load()), [name]: value }, 0o600) }) },
    unset(name) {
      return mutex.run(async () => {
        const all = await load()
        if (!(name in all)) return
        delete all[name]
        await writeJson(path, all, 0o600)
      })
    },
  }
}

/** The credential store first; the file when that store refuses (older hosts reject scopes they do not know). */
export function layeredKeyStore(primary: KeyStore, fallback: KeyStore): KeyStore {
  return {
    async get(name) {
      const value = await primary.get(name).catch(() => undefined)
      return value ?? await fallback.get(name)
    },
    async set(name, value) {
      try {
        await primary.set(name, value)
        await fallback.unset(name).catch(() => {})
      } catch {
        await fallback.set(name, value)
      }
    },
    async unset(name) {
      await primary.unset(name).catch(() => {})
      await fallback.unset(name)
    },
  }
}

/** The keys in memory, so the tools read them without waiting, backed by a store. */
export class Keys {
  private values: Partial<Record<KeyName, string>> = {}
  private loading: Promise<void> | undefined

  constructor(private store: KeyStore) {}

  /** Read every key from the store. */
  load(): Promise<void> {
    this.loading = (async () => {
      const next: Partial<Record<KeyName, string>> = {}
      for (const name of KEY_NAMES) {
        const value = await this.store.get(name).catch(() => undefined)
        if (value !== undefined && value !== '') next[name] = value
      }
      this.values = next
    })()
    return this.loading
  }

  /** Change where keys are kept (the credential store arrived) and read them from there. */
  async use(store: KeyStore): Promise<void> {
    await this.loading
    this.store = store
    await this.load()
  }

  get(name: KeyName): string { return this.values[name] ?? '' }

  /** Which keys are set; all the settings page is told. */
  configured(): Record<KeyName, boolean> {
    return Object.fromEntries(KEY_NAMES.map(name => [name, this.get(name) !== ''])) as Record<KeyName, boolean>
  }

  async set(name: KeyName, value: string): Promise<void> {
    const key = value.trim()
    if (!validKey(name, key)) throw new Error('That does not look like an API key.')
    await this.store.set(name, key)
    this.values[name] = key
  }

  async unset(name: KeyName): Promise<void> {
    await this.store.unset(name)
    delete this.values[name]
  }

  /** Settings as the tools see them: the stored keys stand in the fields they used to be typed into. */
  apply(settings: Settings): Settings {
    const out = { ...settings }
    for (const name of KEY_NAMES) if (this.values[name] !== undefined) out[KEY_FIELDS[name]] = this.values[name]
    return out
  }

  /**
   * Move keys still written in the settings (versions before 0.5.1) into the store.
   * Returns the settings fields that can now be removed from the settings.
   */
  async adopt(settings: Settings): Promise<string[]> {
    const moved: string[] = []
    for (const name of KEY_NAMES) {
      const legacy = settings[KEY_FIELDS[name]]
      if (legacy === '') continue
      // A key set since then wins over the one left behind in the settings.
      if (this.get(name) === '') {
        try { await this.set(name, legacy) } catch { continue }
      }
      if (await this.store.get(name).catch(() => undefined) !== undefined) moved.push(KEY_FIELDS[name])
    }
    return moved
  }
}
