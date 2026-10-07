/** Plugin-owned JSON storage under the DSH home, independent of any workspace. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ENTRY_ID } from './settings.js'

/**
 * Directory holding this plugin's state. Precedence: `COPYLEE_ACADEMIC_HOME`,
 * `$DSH_HOME/storages/copylee-academic`, then `~/.dsh/storages/copylee-academic`.
 */
export function resolveDataDir(): string {
  const explicit = process.env.COPYLEE_ACADEMIC_HOME?.trim()
  if (explicit) return explicit
  const dshHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh')
  return join(dshHome, 'storages', ENTRY_ID)
}

/** Read and parse one JSON file; `undefined` when it does not exist or cannot be parsed. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Atomically replace one JSON file (write a sibling, then rename). */
export async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
    await rename(staging, path)
  } catch (error) {
    await unlink(staging).catch(() => {})
    throw error
  }
}

/** Serialize async operations on one resource. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => {})
    return next
  }
}
