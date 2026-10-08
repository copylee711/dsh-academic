/**
 * Starting Zotero when a tool needs it and it is not running. Zotero has no
 * windowless mode, and its launcher ignores a "start minimized" request, so on
 * Windows a short script sends the window to the taskbar the moment it shows
 * and hands the focus back. The window is not hidden: Zotero asks the user
 * there before the first write, and a hidden window could not be brought back.
 */
import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Launcher {
  /** Whether starting Zotero is switched on in settings. */
  enabled(): boolean
  /** Start Zotero. Resolves with why it could not, or undefined once it was started. */
  start(): Promise<string | undefined>
}

export interface LaunchDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?(path: string): Promise<boolean>
  /** Output of a command, or undefined when it failed. */
  run?(command: string, args: string[]): Promise<string | undefined>
  /** Start a program that outlives this one. */
  detach?(command: string, args: string[], env?: NodeJS.ProcessEnv): void
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

const run = (command: string, args: string[]): Promise<string | undefined> => new Promise(resolve => {
  execFile(command, args, { windowsHide: true, timeout: 5_000 }, (error, stdout) => { resolve(error ? undefined : stdout) })
})

function detach(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  // Only the script's console is hidden; a program's own window is left to the program.
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: /powershell/i.test(command), ...(env === undefined ? {} : { env }) })
  child.on('error', () => {})
  child.unref()
}

/**
 * Minimizes the Zotero window as it appears and returns the focus to the window that had it.
 * It only watches: Zotero itself is started by this process, because a program started from
 * this script's own hidden console is closed along with it.
 */
const WINDOWS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DshZotero {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$front = [DshZotero]::GetForegroundWindow()
$watch = [Diagnostics.Stopwatch]::StartNew()
$seen = $null
while ($watch.Elapsed.TotalSeconds -lt 40) {
  Start-Sleep -Milliseconds 100
  foreach ($p in Get-Process -Name zotero -ErrorAction SilentlyContinue) {
    if ($p.MainWindowHandle -eq 0) { continue }
    if ($null -eq $seen) { $seen = $watch.Elapsed.TotalSeconds }
    if (-not [DshZotero]::IsIconic($p.MainWindowHandle)) {
      [void][DshZotero]::ShowWindowAsync($p.MainWindowHandle, 7)
      if ($front -ne $p.MainWindowHandle -and [DshZotero]::GetForegroundWindow() -ne $front) { [void][DshZotero]::SetForegroundWindow($front) }
    }
  }
  if ($null -ne $seen -and $watch.Elapsed.TotalSeconds - $seen -gt 6) { break }
}
`

/** Where Zotero is installed: the path from settings, else what the system knows, else the usual places. */
export async function findZotero(custom: string, deps: LaunchDeps = {}): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const there = deps.exists ?? exists
  const ask = deps.run ?? run
  if (custom !== '') return await there(custom) ? custom : undefined
  const candidates: string[] = []
  if (platform === 'win32') {
    // The installer records the path here wherever the user put Zotero.
    for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\zotero.exe', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\zotero.exe', 'HKCR\\zotero\\shell\\open\\command']) {
      const found = /REG_SZ\s+"?([^"\r\n]+?zotero\.exe)/i.exec(await ask('reg', ['query', key, '/ve']) ?? '')?.[1]
      if (found !== undefined) candidates.push(found)
    }
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) if (root) candidates.push(join(root, 'Zotero', 'zotero.exe'))
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Zotero.app', join(homedir(), 'Applications', 'Zotero.app'))
  } else {
    const onPath = (await ask('which', ['zotero']))?.trim()
    if (onPath) candidates.push(onPath)
    candidates.push(join(homedir(), 'Zotero', 'zotero'), '/opt/zotero/zotero', '/usr/lib/zotero/zotero', '/usr/bin/zotero')
  }
  for (const candidate of candidates) if (await there(candidate)) return candidate
  return undefined
}

export function createLauncher(options: { enabled(): boolean; path(): string }, deps: LaunchDeps = {}): Launcher {
  const platform = deps.platform ?? process.platform
  const go = deps.detach ?? detach
  return {
    enabled: options.enabled,
    async start() {
      const custom = options.path()
      const target = await findZotero(custom, deps)
      if (target === undefined) return custom === '' ? 'Zotero was not found on this computer' : `there is no file at the Zotero path in settings (${custom})`
      try {
        if (platform === 'win32') {
          go('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')])
          go(target, [])
        } else if (platform === 'darwin') {
          // -g: do not bring it to the front; -j: start hidden.
          go('open', ['-g', '-j', target])
        } else {
          go(target, [])
        }
        return undefined
      } catch (error) {
        return `Zotero could not be started (${error instanceof Error ? error.message : String(error)})`
      }
    },
  }
}
