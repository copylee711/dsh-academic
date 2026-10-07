/**
 * Papers published as markup, turned into plain text with Markdown headings:
 * the HTML arXiv renders from LaTeX (LaTeXML, also what ar5iv serves) and the
 * JATS XML of PubMed Central. Headings survive, so a paper can be read by
 * section; formulas come out as the LaTeX the authors wrote.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', times: '×', minus: '−' }

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all)
}

function tidy(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const inlineText = (html: string): string => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/** The `<article>` of an arXiv HTML page as text; undefined when the page holds no paper. */
export function arxivHtmlToText(html: string): string | undefined {
  const start = html.search(/<article[\s>]/i)
  const end = html.lastIndexOf('</article>')
  if (start === -1 || end <= start) return undefined
  let body = html.slice(start, end)
    .replace(/<(script|style|nav|button|svg)\b[\s\S]*?<\/\1>/gi, '')
    // A formula is kept as its LaTeX source, which LaTeXML puts in alttext.
    .replace(/<math\b([^>]*)>[\s\S]*?<\/math>/gi, (_all, attributes: string) => {
      const tex = /alttext="([^"]*)"/i.exec(attributes)?.[1]
      if (tex === undefined) return ''
      return /display="block"/i.test(attributes) ? `\n$$${tex}$$\n` : `$${tex}$`
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inlineText(inner)}\n\n`)
    .replace(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/gi, (_all, inner: string) => `\n[${inlineText(inner)}]\n`)
    .replace(/<\/t[dh]>/gi, ' | ').replace(/<\/tr>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/section|\/li|\/table|\/figure|\/blockquote)\b[^>]*>/gi, '\n')
  // What is left of the layout tables around numbered equations.
  body = tidy(body).replace(/^[ |]*\|[ |]*$/gm, '').replace(/ \|$/gm, '').replace(/\n{3,}/g, '\n\n')
  return body.length < 500 ? undefined : body
}

/** A PubMed Central article (JATS) as text. */
export function jatsToText(xml: string): string | undefined {
  const title = /<article-title\b[^>]*>([\s\S]*?)<\/article-title>/i.exec(xml)?.[1]
  const abstract = /<abstract\b[^>]*>([\s\S]*?)<\/abstract>/i.exec(xml)?.[1]
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(xml)?.[1]
  if (body === undefined) return undefined
  const references = /<ref-list\b[^>]*>([\s\S]*?)<\/ref-list>/i.exec(xml)?.[1]
  const block = (source: string, baseDepth: number): string => {
    let depth = baseDepth
    return source
      .replace(/<(tex-math)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_all, _tag, tex: string) => ` $${tex.trim()}$ `)
      .replace(/<(table-wrap|fig)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_all, _tag, inner: string) => {
        const label = /<label\b[^>]*>([\s\S]*?)<\/label>/i.exec(inner)?.[1] ?? ''
        const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(inner)?.[1] ?? ''
        const rows = inner.replace(/<caption\b[\s\S]*?<\/caption>/i, '').replace(/<label\b[\s\S]*?<\/label>/i, '').replace(/<\/t[dh]>/gi, ' | ').replace(/<\/tr>/gi, '\n')
        return `\n[${inlineText(`${label} ${caption}`)}]\n${rows}\n`
      })
      // Section depth is the nesting of <sec>; its <title> becomes the heading.
      .replace(/<sec\b[^>]*>|<\/sec>|<title\b[^>]*>([\s\S]*?)<\/title>/gi, (all, inner: string | undefined) => {
        if (/^<sec/i.test(all)) { depth++; return '\n' }
        if (/^<\/sec/i.test(all)) { depth--; return '\n' }
        return `\n\n${'#'.repeat(Math.min(6, Math.max(2, depth + 1)))} ${inlineText(inner ?? '')}\n\n`
      })
      .replace(/<\/(p|list-item|ref)>/gi, '\n\n')
      .replace(/<list-item\b[^>]*>/gi, '- ')
  }
  const parts = [
    title === undefined ? '' : `# ${inlineText(title)}`,
    abstract === undefined ? '' : `## Abstract\n\n${tidy(block(abstract, 2))}`,
    tidy(block(body, 0)),
    references === undefined ? '' : `## References\n\n${tidy(block(references.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, ''), 1))}`,
  ].filter(Boolean)
  const text = parts.join('\n\n')
  return text.length < 500 ? undefined : text
}

export interface Section { id: string; level: number; title: string; start: number; end: number }

/** The headings of a text with Markdown headings, numbered in reading order. */
export function outlineOf(text: string): Section[] {
  const sections: Section[] = []
  const heading = /^(#{1,6}) (.+)$/gm
  for (let match = heading.exec(text); match !== null; match = heading.exec(text)) {
    sections.push({ id: String(sections.length + 1), level: match[1]!.length, title: match[2]!.trim(), start: match.index, end: text.length })
  }
  // A section runs to the next heading at its level or above.
  sections.forEach((section, index) => {
    const next = sections.slice(index + 1).find(other => other.level <= section.level)
    if (next !== undefined) section.end = next.start
  })
  return sections
}

/** A section by its number in the outline, or by (part of) its title. */
export function findSection(sections: readonly Section[], wanted: string): Section | undefined {
  const text = wanted.trim().toLowerCase()
  return sections.find(section => section.id === text)
    ?? sections.find(section => section.title.toLowerCase() === text)
    ?? sections.find(section => section.title.toLowerCase().replace(/^[\d.ivx]+\s+/, '') === text)
    ?? sections.find(section => section.title.toLowerCase().includes(text))
}
