/** Conversation card for paper_search / paper_get / paper_citations: the papers found, each a link. */
import * as React from 'react'
import { ACCENT } from './accent.js'

interface CardPaper { title: string; authors: string; year?: number; venue?: string; url?: string; citations?: number; open?: boolean }

type Block = {
  meta?: unknown
  content?: Array<{ type: string; text?: string }>
  resultView?: { meta?: unknown; content?: Array<{ type: string; text?: string }> } | null
}

const h = React.createElement

const S: Record<string, React.CSSProperties> = {
  root: { display: 'grid', gap: 2, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary, inherit)' },
  head: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 4 },
  row: { display: 'grid', gap: 1, padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))' },
  title: { fontWeight: 500, color: 'inherit', textDecoration: 'none' },
  facts: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' },
  badge: { display: 'inline-block', whiteSpace: 'nowrap', marginLeft: 6, padding: '0 6px', fontSize: 11, borderRadius: 8, border: `1px solid ${ACCENT}`, color: ACCENT },
  more: { padding: '4px 0', fontSize: 12, background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', textAlign: 'left' },
}

/** The papers a tool-call block carries, with the words that were searched for. */
export function papersOf(block: Block | undefined): { label: string; papers: CardPaper[] } | undefined {
  const meta = block?.meta ?? block?.resultView?.meta
  if (typeof meta !== 'object' || meta === null || (meta as { kind?: unknown }).kind !== 'copylee-academic-papers') return undefined
  const papers = (meta as { papers?: unknown }).papers
  if (!Array.isArray(papers)) return undefined
  return {
    label: typeof (meta as { label?: unknown }).label === 'string' ? (meta as { label: string }).label : '',
    papers: papers.filter((paper): paper is CardPaper => typeof paper === 'object' && paper !== null && typeof (paper as CardPaper).title === 'string'),
  }
}

/** Only web links are made clickable. */
const safeUrl = (url: string | undefined): string | undefined => (url !== undefined && /^https?:\/\//i.test(url) ? url : undefined)

export function PaperToolCard(props: { block?: Block; phase?: 'preparing' | 'start' | 'result' }) {
  const [all, setAll] = React.useState(false)
  const found = papersOf(props.block)
  if (found === undefined || found.papers.length === 0) {
    const running = props.phase !== undefined ? props.phase !== 'result' : props.block?.content === undefined && props.block?.resultView == null
    if (running) return h('div', { style: S.head }, '正在查询学术数据库…')
    const text = (props.block?.content ?? props.block?.resultView?.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
    // The first line says what happened; the rest is for the model.
    return h('div', { style: S.head }, text.split('\n')[0]?.slice(0, 200) || '没有结果')
  }
  const shown = all ? found.papers : found.papers.slice(0, 5)
  return h('div', { style: S.root },
    h('div', { style: S.head }, `${String(found.papers.length)} 篇论文${found.label ? ` · ${found.label.slice(0, 80)}` : ''}`),
    shown.map((paper, index) => {
      const url = safeUrl(paper.url)
      const facts = [paper.authors, paper.year, paper.venue, paper.citations === undefined ? '' : `被引 ${String(paper.citations)}`].filter(Boolean).join(' · ')
      return h('div', { key: `${String(index)}-${paper.title}`, style: S.row },
        h('div', null,
          url === undefined ? h('span', { style: S.title }, paper.title) : h('a', { href: url, target: '_blank', rel: 'noreferrer noopener', style: S.title }, paper.title),
          paper.open === true ? h('span', { style: S.badge }, '开放获取') : null,
        ),
        facts ? h('div', { style: S.facts }, facts) : null,
      )
    }),
    found.papers.length > 5 ? h('button', { type: 'button', style: S.more, onClick: () => { setAll(!all) } }, all ? '收起' : `显示全部 ${String(found.papers.length)} 篇`) : null,
  )
}
