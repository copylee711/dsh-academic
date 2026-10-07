/**
 * Browser half: the "学术" section in Settings. It reads the plugin's own
 * Loader entry through `remote.settings.describe()` and writes with
 * `remote.settings.mutate()`; every field is volatile and each change saves
 * itself. The Zotero status comes from the host route in ../index.ts.
 */
import * as React from 'react'
import { DEFAULTS, ENTRY_ID, resolveConfig, type Settings } from '../settings.js'
import { ACCENT, ACCENT_INK, AccentPicker, installAccent } from './accent.js'
import { registerNavIcon } from './nav-icon.js'
import { PaperToolCard } from './paper-card.js'

const STATUS_ROUTE = '/api/dsh-academic/status'
const LABEL = '学术'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }
interface NamespaceView { ns: string; value: unknown; revision: number }

interface ClientContext {
  effect(execute: () => (() => void) | void, label?: string): void
  slots: {
    inject(name: string, register: () => unknown): void
    register(meta: Record<string, unknown>, render: (props: unknown) => unknown): unknown
  }
  remote: {
    $on?(event: string, listener: (...args: unknown[]) => void): () => void
    settings: {
      describe(): Promise<RemoteResult<{ writable: boolean; namespaces: NamespaceView[] }>>
      mutate(ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[], expectedRevision?: number): Promise<RemoteResult<unknown>>
    }
  }
}

interface Status { ok: boolean; error?: string; zotero?: { running: boolean; writable: boolean; version?: string; items?: number; error?: string }; skills?: Array<{ name: string; description: string }>; skillsRegistered?: boolean }

const SKILL_LABELS: Record<string, string> = {
  'academic-literature-review': '文献综述',
  'academic-paper-reading': '论文精读',
  'academic-related-work': '相关工作',
  'academic-proposal': '开题报告与研究计划',
  'academic-writing': '论文写作',
  'academic-polishing': '论文润色与翻译',
  'academic-reviewer': '模拟审稿',
  'academic-response': '回复审稿意见',
  'academic-statistics': '统计报告审查',
  'academic-data-statement': '数据可用性声明',
  'academic-ref-verifier': '参考文献核验',
}

const STYLES = [['apa', 'APA'], ['ieee', 'IEEE'], ['nature', 'Nature'], ['chicago-author-date', 'Chicago'], ['china-national-standard-gb-t-7714-2015-numeric', 'GB/T 7714']] as const
const CHUNKS = [6_000, 12_000, 24_000, 48_000]
const LIMITS = [10, 20, 50, 100]
const SOURCES = [['arxiv', 'arXiv'], ['openalex', 'OpenAlex'], ['crossref', 'Crossref'], ['semanticscholar', 'Semantic Scholar'], ['pubmed', 'PubMed'], ['europepmc', 'Europe PMC'], ['dblp', 'DBLP']] as const
const PAPER_CARD_TOOLS = ['paper_search', 'paper_get', 'paper_citations']

const h = React.createElement

const S: Record<string, React.CSSProperties> = {
  page: { display: 'grid', gap: 20, maxWidth: 880, paddingBottom: 32, color: 'var(--dsw-alias-label-primary, inherit)' },
  title: { margin: 0, fontSize: 20, fontWeight: 600 },
  subtitle: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #666)' },
  card: { display: 'grid', gap: 14, padding: 16, borderRadius: 'var(--dsw-radius-lg, 12px)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))' },
  cardTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary, #888)' },
  toggleRow: { display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' },
  toggleText: { display: 'grid', gap: 4, fontSize: 13, fontWeight: 500 },
  error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d33)' },
  ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #2a2)' },
  statusLine: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 },
  dot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto', alignSelf: 'center' },
  chips: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  secondary: { padding: '6px 12px', fontSize: 12, borderRadius: 'var(--dsw-radius-md, 8px)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  input: { width: 220, padding: '6px 10px', fontSize: 13, borderRadius: 'var(--dsw-radius-md, 8px)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
}

const chosen = { background: ACCENT, borderColor: ACCENT, color: ACCENT_INK }

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange(value: boolean): void }) {
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled,
    onClick: () => onChange(!checked),
    style: {
      flex: '0 0 auto', width: 40, height: 22, borderRadius: 11, border: 'none', padding: 2, cursor: disabled ? 'default' : 'pointer',
      background: checked ? ACCENT : 'var(--dsw-alias-border-l3, rgba(127,127,127,.35))', opacity: disabled ? 0.5 : 1, transition: 'background .15s',
    },
  }, h('span', { style: { display: 'block', width: 18, height: 18, borderRadius: 9, background: checked ? ACCENT_INK : '#fff', transform: checked ? 'translateX(18px)' : 'none', transition: 'transform .15s' } }))
}

/** A text field that saves when the user leaves it or presses Enter. */
function TextField({ value, disabled, placeholder, secret, onCommit }: { value: string; disabled: boolean; placeholder: string; secret?: boolean; onCommit(value: string): void }) {
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => { setDraft(value) }, [value])
  const commit = (): void => { if (draft.trim() !== value) onCommit(draft.trim()) }
  return h('input', {
    type: secret === true ? 'password' : 'text', autoComplete: 'off', value: draft, disabled, placeholder, style: S.input,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value) },
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') commit() },
  })
}

function zoteroLine(status: Status | null): { color: string; text: string } {
  if (status === null) return { color: '#999', text: '检查中…' }
  if (!status.ok || status.zotero === undefined) return { color: '#d33', text: `无法连接到插件：${status.error ?? ''}` }
  const zotero = status.zotero
  if (!zotero.running) return { color: '#999', text: '未检测到 Zotero。请先启动 Zotero。' }
  if (zotero.error !== undefined) return { color: '#d33', text: 'Zotero 已运行，但本地 API 未开启。请在 Zotero 的 设置 > 高级 中勾选“允许此计算机上的其他应用程序与 Zotero 通讯”。' }
  const version = zotero.version ? ` ${zotero.version}` : ''
  const items = zotero.items === undefined ? '' : `，当前文库 ${String(zotero.items)} 个条目`
  return { color: '#2a2', text: `已连接 Zotero${version}${items}。${zotero.writable ? '支持写入。' : '此版本的本地 API 只读（写入需要 Zotero 10 或更高版本）。'}` }
}

function AcademicSection({ ctx }: { ctx: ClientContext }) {
  const [loaded, setLoaded] = React.useState(false)
  const [writable, setWritable] = React.useState(false)
  const [view, setView] = React.useState<NamespaceView | undefined>(undefined)
  const [settings, setSettings] = React.useState<Settings>(DEFAULTS)
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [status, setStatus] = React.useState<Status | null>(null)
  const [checking, setChecking] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const result = await ctx.remote.settings.describe()
      if (!result.ok) throw new Error(result.error.message)
      const found = result.value.namespaces.find(item => item.ns === ENTRY_ID)
      setWritable(result.value.writable)
      setView(found)
      setSettings(resolveConfig(found?.value))
    } catch (error) {
      setMessage({ kind: 'error', text: `读取设置失败：${(error as Error).message}` })
    } finally {
      setLoaded(true)
    }
  }, [ctx])

  const refreshStatus = React.useCallback(async () => {
    setChecking(true)
    try {
      const response = await fetch(STATUS_ROUTE, { credentials: 'same-origin' })
      setStatus(await response.json() as Status)
    } catch {
      setStatus({ ok: false, error: '无响应' })
    } finally {
      setChecking(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    void refreshStatus()
    return ctx.remote.$on?.('settings/document-updated', (ns: unknown) => { if (ns === ENTRY_ID) void load() }) ?? undefined
  }, [ctx, load, refreshStatus])

  const disabled = !writable || view === undefined

  // Each change saves itself: there is no Save button to forget.
  const change = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (view === undefined) return
    setSettings(previous => ({ ...previous, [key]: value }))
    try {
      const result = await ctx.remote.settings.mutate(ENTRY_ID, [{ op: 'set', path: [key], value }], view.revision)
      if (!result.ok) throw new Error(result.error.message)
      setMessage({ kind: 'ok', text: '已保存，下一次调用即生效' })
    } catch (error) {
      setMessage({ kind: 'error', text: `保存失败：${(error as Error).message}` })
    }
    await load()
    if (key === 'zoteroBaseUrl' || key === 'zoteroLibrary') void refreshStatus()
  }

  if (!loaded) return h('div', { style: S.page }, '加载中…')

  const line = zoteroLine(status)
  const row = (title: string, hint: string, control: React.ReactNode) => h('div', { style: S.toggleRow },
    h('div', { style: S.toggleText }, title, h('span', { style: { ...S.hint, fontWeight: 400 } }, hint)),
    control,
  )

  return h('div', { style: S.page },
    h('div', null,
      h('h2', { style: S.title }, LABEL),
      h('p', { style: S.subtitle }, '学术工作用的工具：连接你电脑上的 Zotero 文库（检索、读批注、读全文、导出引文，开启写入后可入库、写笔记、整理）；在 arXiv、OpenAlex、Crossref、PubMed 等学术数据库中检索论文、阅读开放获取全文、获取准确引文、核验参考文献。'),
    ),
    view === undefined ? h('div', { style: S.error }, '没有找到本插件的设置项（插件可能未启用）。') : null,
    view !== undefined && !writable ? h('div', { style: S.error }, '当前设置为只读。') : null,

    h('section', { style: S.card },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('h3', { style: S.cardTitle }, 'Zotero'),
        h('button', { type: 'button', style: S.secondary, disabled: checking, onClick: () => { void refreshStatus() } }, checking ? '检查中…' : '重新检查'),
      ),
      h('div', { style: S.statusLine }, h('span', { style: { ...S.dot, background: line.color } }), h('span', null, line.text)),
      row('启用 Zotero 工具', '关闭后 AI 看不到任何 Zotero 工具。', h(Switch, { checked: settings.zotero, disabled, label: '启用 Zotero 工具', onChange: value => { void change('zotero', value) } })),
      row('允许修改文库', '开启后 AI 可以按 DOI / arXiv 编号添加文献、新建或追加笔记、增删标签、移入移出分类、新建分类；不会删除任何条目。需要 Zotero 10 或更高版本。每次修改 DSH 都会先询问你；第一次修改时 Zotero 自己也会弹窗确认，选“始终允许”后不再弹出。',
        h(Switch, { checked: settings.zoteroWrite, disabled: disabled || !settings.zotero, label: '允许修改文库', onChange: value => { void change('zoteroWrite', value) } })),
      row('默认文库', '填 user 表示“我的文库”；群组文库填它的数字 ID（可以让 AI 列出群组）。', h(TextField, { value: settings.zoteroLibrary, disabled, placeholder: 'user', onCommit: value => { void change('zoteroLibrary', value || DEFAULTS.zoteroLibrary) } })),
      row('本地服务地址', 'Zotero 本地服务的地址，只接受本机地址。一般不用改。', h(TextField, { value: settings.zoteroBaseUrl, disabled, placeholder: DEFAULTS.zoteroBaseUrl, onCommit: value => { void change('zoteroBaseUrl', value || DEFAULTS.zoteroBaseUrl) } })),
    ),

    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '论文检索'),
      row('启用论文工具', '多源检索论文、查看论文详情与引用关系、阅读开放获取的全文（arXiv、PubMed Central、开放获取 PDF）、从 DOI 注册机构获取引文、核验参考文献是否真实存在。关闭后 AI 看不到这些工具。',
        h(Switch, { checked: settings.papers, disabled, label: '启用论文工具', onChange: value => { void change('papers', value) } })),
      h('div', { style: { display: 'grid', gap: 8 } },
        h('div', { style: S.toggleText }, '默认数据源', h('span', { style: { ...S.hint, fontWeight: 400 } }, '检索时同时查询选中的数据源，同一篇论文只返回一次；AI 也可以按需指定其中几个。全部无需密钥。Semantic Scholar 不填密钥时经常被限流，届时自动跳过。DBLP 在部分网络下会要求浏览器验证而无法使用，默认不选。')),
        h('div', { style: S.chips }, SOURCES.map(([id, label]) => {
          const on = settings.sources.includes(id)
          return h('button', {
            key: id, type: 'button', disabled: disabled || !settings.papers, 'aria-pressed': on,
            onClick: () => { void change('sources', on ? settings.sources.filter(source => source !== id) : [...settings.sources, id]) },
            style: { ...S.secondary, ...(on ? chosen : {}) },
          }, label)
        })),
      ),
      row('联系邮箱（可选）', 'Crossref、OpenAlex、NCBI、Europe PMC、Unpaywall 希望调用方留一个联系邮箱，留了限速更宽松。填写后，查找开放获取全文时才会询问 Unpaywall。邮箱只发给这五家。', h(TextField, { value: settings.email, disabled, placeholder: 'you@example.org', onCommit: value => { void change('email', value) } })),
      row('Semantic Scholar API Key（可选）', '在 semanticscholar.org 免费申请。填写后可稳定获得一句话摘要和引用数。', h(TextField, { value: settings.s2Key, disabled, secret: true, placeholder: '未填写', onCommit: value => { void change('s2Key', value) } })),
      row('OpenAlex API Key（可选）', '不填时使用匿名额度，一般够用。', h(TextField, { value: settings.openalexKey, disabled, secret: true, placeholder: '未填写', onCommit: value => { void change('openalexKey', value) } })),
      row('NCBI API Key（可选）', 'PubMed 的密钥，填写后限速从每秒 3 次提高到 10 次。', h(TextField, { value: settings.ncbiKey, disabled, secret: true, placeholder: '未填写', onCommit: value => { void change('ncbiKey', value) } })),
    ),

    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '引文与阅读'),
      h('div', { style: { display: 'grid', gap: 8 } },
        h('div', { style: S.toggleText }, '默认引文样式', h('span', { style: { ...S.hint, fontWeight: 400 } }, 'AI 让 Zotero 生成格式化参考文献时使用的样式（BibTeX、RIS 导出不受影响）。也可以在下面填写其他 CSL 样式 ID（zotero.org/styles 上的 ID）；Zotero 里没有的样式会由它自动下载。')),
        h('div', { style: S.chips }, STYLES.map(([id, label]) => h('button', {
          key: id, type: 'button', disabled, onClick: () => { void change('citationStyle', id) },
          style: { ...S.secondary, ...(settings.citationStyle === id ? chosen : {}) },
        }, label))),
        h(TextField, { value: settings.citationStyle, disabled, placeholder: DEFAULTS.citationStyle, onCommit: value => { void change('citationStyle', value || DEFAULTS.citationStyle) } }),
      ),
      h('div', { style: { display: 'grid', gap: 8 } },
        h('div', { style: S.toggleText }, '单次读取全文的长度', h('span', { style: { ...S.hint, fontWeight: 400 } }, 'AI 分段阅读论文时每段的最大字符数。越大读得越快，也越费 token。')),
        h('div', { style: S.chips }, CHUNKS.map(size => h('button', {
          key: size, type: 'button', disabled, onClick: () => { void change('maxContentChars', size) },
          style: { ...S.secondary, ...(settings.maxContentChars === size ? chosen : {}) },
        }, `${String(size)} 字符${size === DEFAULTS.maxContentChars ? '（默认）' : ''}`))),
      ),
      h('div', { style: { display: 'grid', gap: 8 } },
        h('div', { style: S.toggleText }, '单次检索条目数上限', h('span', { style: { ...S.hint, fontWeight: 400 } }, '一次文库检索或论文检索最多返回多少个条目；更多结果由 AI 翻页或缩小范围获取。')),
        h('div', { style: S.chips }, LIMITS.map(count => h('button', {
          key: count, type: 'button', disabled, onClick: () => { void change('maxResults', count) },
          style: { ...S.secondary, ...(settings.maxResults === count ? chosen : {}) },
        }, `${String(count)} 条${count === DEFAULTS.maxResults ? '（默认）' : ''}`))),
      ),
      message === null ? null : h('span', { style: message.kind === 'ok' ? S.ok : S.error }, message.text),
    ),

    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '学术技能'),
      row('启用内置技能', '技能是给 AI 的分步工作方法，AI 在遇到对应任务时自行加载，你也可以用斜杠命令点名。关闭后 AI 看不到下面这些技能；你自己装在 ~/.dsh/skills 里的同名技能优先于内置的。开关对 AI 立即生效，输入框的斜杠菜单在刷新页面后更新。',
        h(Switch, { checked: settings.skills, disabled, label: '启用内置技能', onChange: value => { void change('skills', value) } })),
      status?.skills === undefined ? null
        : status.skills.length === 0 ? h('div', { style: S.error }, '安装包里没有找到技能文件。')
          : status.skillsRegistered === false ? h('div', { style: S.error }, '当前 DSH 没有提供技能注册服务，内置技能不可用。') : null,
      (status?.skills ?? []).map(skill => {
        const on = !settings.disabledSkills.includes(skill.name)
        return h('div', { key: skill.name, style: S.toggleRow },
          h('div', { style: S.toggleText }, `${SKILL_LABELS[skill.name] ?? skill.name}`,
            h('span', { style: { ...S.hint, fontWeight: 400 } }, `${skill.name} · ${skill.description.length > 150 ? `${skill.description.slice(0, 150)}…` : skill.description}`)),
          h(Switch, { checked: on && settings.skills, disabled: disabled || !settings.skills, label: skill.name, onChange: value => { void change('disabledSkills', value ? settings.disabledSkills.filter(name => name !== skill.name) : [...settings.disabledSkills, skill.name]) } }),
        )
      }),
      h('p', { style: S.hint }, '论文写作、润色、模拟审稿、回复审稿意见、统计审查、数据可用性声明、参考文献核验七项改编自开源项目 nature-skills（Apache-2.0），其余为本插件编写。'),
    ),

    h(AccentPicker, null),
  )
}

export const inject = ['slots', 'remote', 'remote.settings']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installAccent(), 'academic: accent colour')
  ctx.effect(() => registerNavIcon(LABEL), 'academic: settings nav icon')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ENTRY_ID,
    order: 63,
    label: () => LABEL,
  }, () => h(AcademicSection, { ctx })))
  for (const tool of PAPER_CARD_TOOLS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: tool }, props => h(PaperToolCard, props as Parameters<typeof PaperToolCard>[0])))
  }
}
