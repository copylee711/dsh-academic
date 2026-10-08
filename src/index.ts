/**
 * @copylee/dsh-academic host bundle: tools for academic work. It connects
 * the Zotero running on this computer (search, read, cite, and, when the
 * user turns it on, add items, notes and tags) and searches the scholarly
 * indexes (arXiv, OpenAlex, Crossref, Semantic Scholar, PubMed, Europe PMC,
 * DBLP), reads open-access full text and checks references.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './system-prompt-service.js'
import type {} from './skills-service.js'
import { createSkillProvider, discoverSkills, skillAppendix, skillsRoot } from './skills/provider.js'
import { join } from 'node:path'
import { pdfText } from './fulltext/pdf.js'
import { TextCache } from './fulltext/resolve.js'
import { createHttp } from './net/http.js'
import { promptText } from './prompt.js'
import { createPaperTools } from './search/tools.js'
import { ALL_SOURCES, DEFAULTS, resolveConfig, ZOTERO_SOURCES, type Settings } from './settings.js'
import { resolveDataDir } from './storage.js'
import { fileKeyStore, ZoteroWriter } from './zotero/auth.js'
import { ZoteroClient } from './zotero/client.js'
import { createLauncher, findZotero } from './zotero/launch.js'
import { libraryOf, libraryPath } from './zotero/refs.js'
import { createReadTools } from './zotero/tools.js'
import { createWriteTools, WRITE_TOOLS } from './zotero/write-tools.js'

export { DEFAULTS, ENTRY_ID, resolveConfig } from './settings.js'

export const name = '@copylee/dsh-academic'
export const inject = ['tools']

export const STATUS_ROUTE = '/api/dsh-academic/status'

export interface Config {
  zotero?: boolean
  zoteroSource?: string
  zoteroApiKey?: string
  zoteroAutoStart?: boolean
  zoteroPath?: string
  zoteroBaseUrl?: string
  zoteroLibrary?: string
  zoteroWrite?: boolean
  citationStyle?: string
  papers?: boolean
  sources?: string[]
  email?: string
  s2Key?: string
  openalexKey?: string
  ncbiKey?: string
  maxResults?: number
  maxContentChars?: number
  skills?: boolean
  disabledSkills?: string[]
}

export const Config: z<Config> = z.object({
  zotero: z.boolean().default(DEFAULTS.zotero).volatile().i18n({
    'zh-CN': { $description: '启用 Zotero 工具：检索文库、读取条目与批注、读全文、导出引文' },
    'en-US': { $description: 'Enable the Zotero tools: search the library, read items, annotations and full text, export citations' },
  }),
  zoteroWrite: z.boolean().default(DEFAULTS.zoteroWrite).volatile().i18n({
    'zh-CN': { $description: '允许修改 Zotero 文库（按 DOI / arXiv 入库、写笔记、改标签与分类）。本机 Zotero 需要 10 或更高版本，在线文库需要密钥有写入权限；每次修改都会先征得你的同意' },
    'en-US': { $description: 'Allow changes to the Zotero library (add by DOI / arXiv id, notes, tags, collections). The local Zotero must be 10 or later, the online library needs a key with write access; every change asks you first' },
  }),
  zoteroSource: z.union(ZOTERO_SOURCES.map(source => z.const(source))).default(DEFAULTS.zoteroSource).volatile().i18n({
    'zh-CN': { $description: '文库来源：auto（优先本机 Zotero，连不上且填了密钥时改用 zotero.org）、local（只用本机）、cloud（只用 zotero.org）' },
    'en-US': { $description: 'Where the library is read: auto (the Zotero on this computer, zotero.org when it cannot be reached and a key is set), local, cloud' },
  }),
  zoteroApiKey: z.string().role('secret').default('').volatile().i18n({
    'zh-CN': { $description: 'zotero.org 的 API 密钥（在 zotero.org/settings/keys 创建）。填写后，Zotero 没有运行时也能访问已同步的文库' },
    'en-US': { $description: 'API key for zotero.org (create one at zotero.org/settings/keys). With it the synced library is reachable while Zotero is not running' },
  }),
  zoteroAutoStart: z.boolean().default(DEFAULTS.zoteroAutoStart).volatile().i18n({
    'zh-CN': { $description: '需要用到本机 Zotero 而它没有运行时，自动启动并最小化到任务栏' },
    'en-US': { $description: 'Start Zotero, minimized, when a tool needs it and it is not running' },
  }),
  zoteroPath: z.string().default('').volatile().i18n({
    'zh-CN': { $description: 'Zotero 程序的路径。留空时自动查找' },
    'en-US': { $description: 'Path of the Zotero program. Found automatically when empty' },
  }),
  zoteroLibrary: z.string().default(DEFAULTS.zoteroLibrary).volatile().i18n({
    'zh-CN': { $description: '默认文库：user（我的文库）或群组的数字 ID' },
    'en-US': { $description: 'Default library: user (My Library) or the numeric id of a group' },
  }),
  zoteroBaseUrl: z.string().default(DEFAULTS.zoteroBaseUrl).volatile().i18n({
    'zh-CN': { $description: 'Zotero 本地服务地址，只接受本机地址（127.0.0.1 / localhost）' },
    'en-US': { $description: 'Address of Zotero\'s local server; loopback addresses only' },
  }),
  citationStyle: z.string().default(DEFAULTS.citationStyle).volatile().i18n({
    'zh-CN': { $description: '格式化引文的默认 CSL 样式 ID，如 apa、ieee、nature、china-national-standard-gb-t-7714-2015-numeric（zotero.org/styles 上的样式 ID）' },
    'en-US': { $description: 'Default CSL style id for formatted citations, e.g. apa, ieee, nature (an id from zotero.org/styles)' },
  }),
  papers: z.boolean().default(DEFAULTS.papers).volatile().i18n({
    'zh-CN': { $description: '启用论文工具：多源检索、论文详情、引用关系、阅读开放获取全文、获取引文、核验参考文献' },
    'en-US': { $description: 'Enable the paper tools: multi-index search, details, citation links, open-access full text, citations, reference checking' },
  }),
  sources: z.array(z.union(ALL_SOURCES.map(source => z.const(source)))).default(DEFAULTS.sources).volatile().i18n({
    'zh-CN': { $description: '论文检索默认使用的数据源' },
    'en-US': { $description: 'Indexes the paper search asks by default' },
  }),
  email: z.string().default('').volatile().i18n({
    'zh-CN': { $description: '联系邮箱（可选）：发给 Crossref、OpenAlex、NCBI、Europe PMC、Unpaywall，用于更宽松的限速；填写后才会向 Unpaywall 查询开放获取全文' },
    'en-US': { $description: 'Contact e-mail (optional), sent to Crossref, OpenAlex, NCBI, Europe PMC and Unpaywall for friendlier limits; Unpaywall is only asked when it is set' },
  }),
  s2Key: z.string().role('secret').default('').volatile().i18n({
    'zh-CN': { $description: 'Semantic Scholar API Key（可选）。不填时使用公共额度，经常被限流' },
    'en-US': { $description: 'Semantic Scholar API key (optional). Without it the shared pool is often rate limited' },
  }),
  openalexKey: z.string().role('secret').default('').volatile().i18n({
    'zh-CN': { $description: 'OpenAlex API Key（可选）' },
    'en-US': { $description: 'OpenAlex API key (optional)' },
  }),
  ncbiKey: z.string().role('secret').default('').volatile().i18n({
    'zh-CN': { $description: 'NCBI（PubMed）API Key（可选）' },
    'en-US': { $description: 'NCBI (PubMed) API key (optional)' },
  }),
  maxResults: z.natural().min(1).max(100).default(DEFAULTS.maxResults).volatile().i18n({
    'zh-CN': { $description: '单次检索最多返回的条目数' },
    'en-US': { $description: 'Most items one search returns' },
  }),
  skills: z.boolean().default(DEFAULTS.skills).volatile().i18n({
    'zh-CN': { $description: '启用内置学术技能（文献综述、论文精读、论文写作与润色、模拟审稿、回复审稿意见等）' },
    'en-US': { $description: 'Enable the bundled academic skills (literature review, close reading, writing and polishing, mock review, response to reviewers …)' },
  }),
  disabledSkills: z.array(z.string()).default([]).volatile().i18n({
    'zh-CN': { $description: '单独关闭的内置技能名称' },
    'en-US': { $description: 'Names of bundled skills switched off individually' },
  }),
  maxContentChars: z.natural().min(2000).max(100000).default(DEFAULTS.maxContentChars).volatile().i18n({
    'zh-CN': { $description: '单次读取全文最多返回的字符数；越大越费 token' },
    'en-US': { $description: 'Most characters of full text one call returns' },
  }),
}) as unknown as z<Config>

/** The slice of a host Agent this plugin touches. */
interface AgentLike { readonly session: { id?: string } }

export function apply(ctx: Context, config: Config = {}): void {
  const settings = (): Settings => resolveConfig(config)
  let writer: ZoteroWriter | undefined
  const launcher = createLauncher({ enabled: () => settings().zoteroAutoStart, path: () => settings().zoteroPath })
  const client = new ZoteroClient(() => settings().zoteroBaseUrl, undefined, () => writer?.forget(), {
    source: () => settings().zoteroSource,
    cloudKey: () => settings().zoteroApiKey,
    launcher,
  })
  writer = new ZoteroWriter(client, fileKeyStore(resolveDataDir()))
  const host = { client, settings }
  const readTools = createReadTools(host)
  const http = createHttp()
  const writeTools = createWriteTools({ ...host, writer, http })
  const paperTools = createPaperTools({ settings, http, pdfText, cache: new TextCache(join(resolveDataDir(), 'papers')) })

  const bundledSkills = discoverSkills(skillsRoot())
  let skillsRegistered = false
  const settingsListeners = new Set<() => void>()

  // Tools follow the switches in Settings without a restart.
  const registered = new Map<string, () => void>()
  let disposed = false
  const sync = (): void => {
    if (disposed) return
    const { zotero, zoteroWrite, papers } = settings()
    const wanted = new Map([...(zotero ? readTools : []), ...(zotero && zoteroWrite ? writeTools : []), ...(papers ? paperTools : [])].map(tool => [tool.name, tool]))
    for (const [toolName, dispose] of registered) if (!wanted.has(toolName)) { dispose(); registered.delete(toolName) }
    for (const [toolName, tool] of wanted) if (!registered.has(toolName)) registered.set(toolName, ctx.tools.register(tool))
  }
  ctx.effect(() => {
    sync()
    // The loader tells only this plugin's own context that its settings changed, so the one
    // listener lives here and passes it on (the skill catalogue below listens through it).
    const stop = ctx.on('loader/volatile-update' as never, (() => { sync(); for (const listener of settingsListeners) listener() }) as never)
    return () => {
      disposed = true
      stop()
      for (const dispose of registered.values()) dispose()
      registered.clear()
    }
  }, 'academic: tools')

  // A change to the library goes through DSH's own approval prompt.
  const writeNames = new Set<string>(WRITE_TOOLS)
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!writeNames.has(exec.name)) return next()
    const agent = exec.agent as AgentLike | undefined
    const approval = (ctx as unknown as { get(name: string): unknown }).get('approval') as { effectivePolicy?(session: unknown): string } | undefined
    // "never" comes from the full-access / auto presets: the user opted out of prompts.
    if (agent && approval?.effectivePolicy?.(agent.session) === 'never') return next()
    const input = (exec.arguments ?? {}) as { identifiers?: unknown[]; refs?: unknown[]; note?: unknown; create_collection?: unknown }
    const what = exec.name === 'zotero_add' ? { en: `add ${String(input.identifiers?.length ?? 0)} work(s) to`, zh: `添加 ${String(input.identifiers?.length ?? 0)} 篇文献到` }
      : exec.name === 'zotero_note' ? { en: input.note ? 'append to a note in' : 'create a note in', zh: input.note ? '追加笔记到' : '新建笔记到' }
      : { en: `change tags / collections of ${String(input.refs?.length ?? 0)} item(s) in`, zh: `修改 ${String(input.refs?.length ?? 0)} 个条目的标签 / 分类于` }
    return {
      kind: 'ask',
      reason: `Change the Zotero library: ${exec.name}`,
      displayReason: { en: `Let DeepSeek ${what.en} your Zotero library?`, 'zh-CN': `允许 DeepSeek ${what.zh}你的 Zotero 文库？` },
    }
  })

  // Settings page bridge (is Zotero there, which version, can it be written); optional so headless hosts still load.
  ctx.inject(['webServer'], (webCtx: Context) => {
    const handler = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
      let body: unknown
      try {
        // Looking at the settings page must not start Zotero: both sides are asked directly.
        const now = settings()
        const top = `${libraryPath(libraryOf(now.zoteroLibrary))}/items/top`
        const probe = now.zoteroSource === 'cloud' ? { running: false, writable: false } : await client.probe()
        let items: number | undefined
        if (probe.running && probe.error === undefined) {
          items = (await client.json(top, { limit: 1 }, undefined, 'local').catch(() => undefined))?.total
        }
        let cloud: Record<string, unknown> = { configured: now.zoteroApiKey !== '' }
        if (now.zoteroApiKey !== '' && now.zoteroSource !== 'local') {
          try {
            const account = await client.cloudAccount()
            const count = (await client.json(top, { limit: 1 }, undefined, 'cloud').catch(() => undefined))?.total
            cloud = { configured: true, ok: true, username: account.username, library: account.library, write: account.write, files: account.files, ...(count === undefined ? {} : { items: count }) }
          } catch (error) {
            cloud = { configured: true, ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
        const program = now.zoteroSource === 'cloud' ? undefined : await findZotero(now.zoteroPath).catch(() => undefined)
        body = { ok: true, zotero: { ...probe, ...(items === undefined ? {} : { items }) }, cloud, program: program !== undefined, ...(client.startError === undefined ? {} : { startError: client.startError }), skills: bundledSkills.map(skill => ({ name: skill.name, description: skill.description })), skillsRegistered }
      } catch (error) {
        body = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: STATUS_ROUTE, handler }), `academic: ${STATUS_ROUTE}`)
  })

  // The bundled skills; optional so a host without a skill registry still loads the tools.
  ctx.inject(['skills'], (skillCtx: Context) => {
    if (bundledSkills.length === 0) return
    const enabled = (skillName: string): boolean => { const now = settings(); return now.skills && !now.disabledSkills.includes(skillName) }
    const provider = createSkillProvider(bundledSkills, { enabled, appendix: () => skillAppendix(bundledSkills, settings(), enabled) })
    skillCtx.effect(() => {
      let invalidate = (): void => {}
      const dispose = skillCtx.skills.registerProvider(control => { invalidate = () => { control.invalidate() }; return provider })
      skillsRegistered = true
      // Switching a skill on or off in Settings changes the catalogue at once.
      const listener = (): void => { invalidate() }
      settingsListeners.add(listener)
      return () => { skillsRegistered = false; settingsListeners.delete(listener); dispose() }
    }, 'academic: skills')
  })

  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'academic:guide',
      order: 74,
      text: () => promptText(settings()),
    }), 'academic: prompt')
  })
}
