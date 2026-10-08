/**
 * Which browser to drive for the sites that have no interface for programs
 * (CNKI, Google Scholar). It has to speak the DevTools protocol, so it is the
 * system's default browser when that is Chrome or Edge (or another Chromium
 * build), and otherwise whichever of them is installed.
 */
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface FindDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?(path: string): Promise<boolean>
  /** Output of a command, or undefined when it failed. */
  run?(command: string, args: string[]): Promise<string | undefined>
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

const run = (command: string, args: string[]): Promise<string | undefined> => new Promise(resolve => {
  execFile(command, args, { windowsHide: true, timeout: 5_000 }, (error, stdout) => { resolve(error ? undefined : stdout) })
})

const WINDOWS = { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe' } as const

/** The browser a `https` link opens in, as a key of WINDOWS; undefined for Firefox and the like. */
function defaultOnWindows(progId: string): keyof typeof WINDOWS | undefined {
  if (/^ChromeHTML/i.test(progId)) return 'chrome'
  if (/^MSEdge/i.test(progId)) return 'edge'
  if (/^Brave/i.test(progId)) return 'brave'
  return undefined
}

export async function findBrowser(custom: string, deps: FindDeps = {}): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const there = deps.exists ?? exists
  const ask = deps.run ?? run
  if (custom !== '') return await there(custom) ? custom : undefined
  const candidates: string[] = []
  if (platform === 'win32') {
    const appPath = async (exe: string): Promise<string | undefined> => {
      for (const hive of ['HKLM', 'HKCU']) {
        const found = /REG_SZ\s+"?([^"\r\n]+?\.exe)/i.exec(await ask('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve']) ?? '')?.[1]
        if (found !== undefined) return found
      }
      return undefined
    }
    const choice = /ProgId\s+REG_SZ\s+(\S+)/i.exec(await ask('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']) ?? '')?.[1]
    const preferred = choice === undefined ? undefined : defaultOnWindows(choice)
    const order = [...new Set([...(preferred === undefined ? [] : [preferred]), 'chrome', 'edge'] as Array<keyof typeof WINDOWS>)]
    for (const name of order) {
      const registered = await appPath(WINDOWS[name])
      if (registered !== undefined) candidates.push(registered)
    }
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (!root) continue
      candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')]) {
      candidates.push(join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'), join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const onPath = (await ask('which', [name]))?.trim()
      if (onPath) candidates.push(onPath)
    }
  }
  for (const candidate of candidates) if (await there(candidate)) return candidate
  return undefined
}
