/**
 * Markdown to the HTML a Zotero note holds. Zotero's note editor keeps a
 * small set of tags, so this covers that set: headings, paragraphs, lists,
 * quotes, code, emphasis, links.
 */

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(text: string): string {
  const codes: string[] = []
  let out = escape(text).replace(/`([^`]+)`/g, (_all, code: string) => { codes.push(code); return `\u0000${String(codes.length - 1)}\u0000` })
  out = out
    .replace(/\[([^\]]+)\]\(((?:https?|zotero):[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return out.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => `<code>${codes[Number(index)]!}</code>`)
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined
  let quote: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) { out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = [] }
    if (list !== undefined) { out.push(`<${list.tag}>${list.items.map(item => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`); list = undefined }
    if (quote.length > 0) { out.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`); quote = [] }
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (/^```/.test(line)) {
      flush()
      const code: string[] = []
      while (++index < lines.length && !/^```/.test(lines[index]!)) code.push(lines[index]!)
      out.push(`<pre>${escape(code.join('\n'))}</pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const quoted = /^>\s?(.*)$/.exec(line)
    if (line.trim() === '') flush()
    else if (heading) { flush(); out.push(`<h${String(heading[1]!.length)}>${inline(heading[2]!)}</h${String(heading[1]!.length)}>`) }
    else if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol'
      if (list?.tag !== tag) { flush(); list = { tag, items: [] } }
      list.items.push((bullet ?? numbered)![1]!)
    }
    else if (quoted) { if (paragraph.length > 0 || list !== undefined) flush(); quote.push(quoted[1]!) }
    else { if (list !== undefined || quote.length > 0) flush(); paragraph.push(line) }
  }
  flush()
  return out.join('\n')
}
