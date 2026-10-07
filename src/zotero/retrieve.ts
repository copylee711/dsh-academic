/**
 * Find the passages of a long text that answer a query: split into passages
 * at paragraph breaks, rank with BM25. Words come from Intl.Segmenter, so
 * Chinese and Japanese text is split into words too.
 */

export interface Passage {
  /** Offset of the passage in the text it came from. */
  start: number
  text: string
  score: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const part of segmenter.segment(text.toLowerCase())) if (part.isWordLike) out.push(part.segment)
  return out
}

/** Cut text into passages of about `size` characters, breaking at blank lines, then line ends, where it can. */
export function splitPassages(text: string, size = 1_200): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + size)
    if (end < text.length) {
      const window = text.slice(start, end)
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\f'))
      const soft = cut > size * 0.4 ? cut : window.lastIndexOf('\n')
      if (soft > size * 0.4) end = start + soft + 1
    }
    const piece = text.slice(start, end)
    if (piece.trim() !== '') out.push({ start, text: piece })
    start = end
  }
  return out
}

export function rankPassages(text: string, query: string, limit: number, size = 1_200): Passage[] {
  const passages = splitPassages(text, size)
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || passages.length === 0) return []
  const docs = passages.map(passage => tokenize(passage.text))
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const frequency = new Map<string, number>()
  for (const term of terms) frequency.set(term, docs.reduce((count, doc) => count + (doc.includes(term) ? 1 : 0), 0))
  const k1 = 1.2
  const b = 0.75
  const scored = passages.map((passage, index) => {
    const doc = docs[index]!
    let score = 0
    for (const term of terms) {
      const tf = doc.reduce((count, word) => count + (word === term ? 1 : 0), 0)
      if (tf === 0) continue
      const n = frequency.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / average))
    }
    return { ...passage, score }
  })
  return scored.filter(passage => passage.score > 0).sort((a, b2) => b2.score - a.score).slice(0, limit)
}
