/**
 * Write access to Zotero 10's local API. A write needs a key; Zotero hands
 * one out after asking the user in its own window (`POST /api/local/authorize`):
 * "Allow" gives a key good for one write, "Always Allow" one that lasts. The
 * lasting key is kept in the plugin's data directory, bound to the Zotero
 * instance that issued it.
 */
import { join } from 'node:path'
import { Mutex, readJson, writeJson } from '../storage.js'
import { ZoteroError, type ZoteroClient, type ZoteroRequest, type ZoteroResponse } from './client.js'

export const APP_NAME = 'DeepSeek Harness (dsh-academic)'

export interface KeyStore {
  load(): Promise<{ serverId: string; key: string } | undefined>
  save(value: { serverId: string; key: string } | undefined): Promise<void>
}

export function fileKeyStore(dataDir: string): KeyStore {
  const path = join(dataDir, 'zotero-key.json')
  return {
    async load() {
      const value = await readJson(path) as { serverId?: unknown; key?: unknown } | undefined
      return typeof value?.serverId === 'string' && typeof value.key === 'string' ? { serverId: value.serverId, key: value.key } : undefined
    },
    async save(value) { await writeJson(path, value ?? {}, 0o600) },
  }
}

export class ZoteroWriter {
  private key: string | undefined
  private lasting = false
  private loaded = false
  private readonly queue = new Mutex()

  constructor(private readonly client: ZoteroClient, private readonly store: KeyStore) {}

  /** Drop the key in memory (the instance changed, or the key was refused). */
  forget(): void {
    this.key = undefined
    this.lasting = false
  }

  private async authorize(signal?: AbortSignal): Promise<string> {
    // The user answers a dialog in Zotero, so this waits far longer than a normal request.
    const response = await this.client.request('local/authorize', { method: 'POST', body: { appName: APP_NAME }, signal, timeoutMs: 180_000 })
    const body = JSON.parse(response.text) as { key?: string; remember?: boolean }
    if (!body.key) throw new ZoteroError('DENIED')
    this.key = body.key
    this.lasting = body.remember === true
    if (this.lasting && this.client.serverId !== undefined) await this.store.save({ serverId: this.client.serverId, key: body.key }).catch(() => {})
    return body.key
  }

  private async currentKey(signal?: AbortSignal): Promise<string> {
    if (this.client.serverId === undefined) {
      const probe = await this.client.probe(signal)
      if (!probe.running) throw new ZoteroError('NOT_RUNNING')
      if (!probe.writable) throw new ZoteroError('READ_ONLY')
    }
    if (!this.loaded) {
      this.loaded = true
      const stored = await this.store.load().catch(() => undefined)
      if (stored !== undefined && stored.serverId === this.client.serverId) { this.key = stored.key; this.lasting = true }
    }
    return this.key ?? await this.authorize(signal)
  }

  /** One write, after any other in flight. Asks the user in Zotero when there is no usable key. */
  write(path: string, request: ZoteroRequest & { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' }): Promise<ZoteroResponse> {
    return this.queue.run(async () => {
      const send = async (key: string): Promise<ZoteroResponse> => {
        try {
          return await this.client.request(path, { ...request, headers: { ...request.headers, 'Zotero-API-Key': key } })
        } finally {
          // A one-time key is spent by the write it went with.
          if (!this.lasting) this.key = undefined
        }
      }
      try {
        return await send(await this.currentKey(request.signal))
      } catch (error) {
        if (!(error instanceof ZoteroError) || error.code !== 'UNAUTHORIZED') throw error
        // The stored key was revoked in Zotero: forget it and ask once more.
        this.forget()
        await this.store.save(undefined).catch(() => {})
        return await send(await this.authorize(request.signal))
      }
    })
  }
}

export interface WriteReport<T = unknown> {
  successful: Record<string, T>
  unchanged: Record<string, string>
  failed: Record<string, { key?: string; code: number; message: string }>
}

export function parseWriteReport<T = unknown>(response: ZoteroResponse): WriteReport<T> {
  const body = (response.text.trim() === '' ? {} : JSON.parse(response.text)) as Partial<WriteReport<T>>
  return { successful: body.successful ?? {}, unchanged: body.unchanged ?? {}, failed: body.failed ?? {} }
}
