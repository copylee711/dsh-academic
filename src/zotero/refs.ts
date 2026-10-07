/**
 * Stable names for Zotero objects: `zotero://user/0/item/ABCD2345` or
 * `zotero://group/<id>/item/ABCD2345`. A bare 8-character key means the
 * library set in the plugin settings.
 */

export interface Library {
  kind: 'user' | 'group'
  /** `0` for the personal library, else the group id. */
  id: string
}

export interface Ref {
  library: Library
  key: string
}

const KEY = /^[A-Z0-9]{8}$/

export function libraryOf(setting: string): Library {
  return /^\d+$/.test(setting) && setting !== '0' ? { kind: 'group', id: setting } : { kind: 'user', id: '0' }
}

/** `users/0` or `groups/<id>`: the API path prefix of a library. */
export function libraryPath(library: Library): string {
  return library.kind === 'group' ? `groups/${library.id}` : 'users/0'
}

export function formatRef(library: Library, key: string, object: 'item' | 'collection' | 'search' = 'item'): string {
  return `zotero://${library.kind}/${library.id}/${object}/${key}`
}

/** Read a ref, a Zotero select link or a bare key. Throws on anything else. */
export function parseRef(input: unknown, fallback: Library): Ref {
  const text = String(input ?? '').trim()
  const own = /^zotero:\/\/(user|group)\/(\d+)\/(?:item|collection|search)\/([A-Za-z0-9]{8})$/.exec(text)
  if (own) return { library: own[1] === 'group' ? { kind: 'group', id: own[2]! } : { kind: 'user', id: '0' }, key: own[3]!.toUpperCase() }
  const select = /^zotero:\/\/(?:select|open-pdf)\/(?:library|groups\/(\d+))\/(?:items|collections|searches)\/([A-Za-z0-9]{8})/.exec(text)
  if (select) return { library: select[1] === undefined ? { kind: 'user', id: '0' } : { kind: 'group', id: select[1] }, key: select[2]!.toUpperCase() }
  const bare = text.toUpperCase()
  if (KEY.test(bare)) return { library: fallback, key: bare }
  throw new Error(`Not a Zotero ref: "${text.slice(0, 80)}". Use a ref a zotero_ tool returned, such as zotero://user/0/item/ABCD2345.`)
}
