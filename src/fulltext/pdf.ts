/** Text of a PDF, page by page. unpdf (a pdf.js build without native parts) is loaded on first use. */
import { readFile, stat } from 'node:fs/promises'

const MAX_PDF_BYTES = 80 * 1_048_576

/** Join pages with a marker line so a quote can be placed on its page. */
export function joinPages(pages: readonly string[]): string {
  return pages.map((page, index) => `[page ${String(index + 1)}]\n${page.trim()}`).join('\n\n')
}

export async function pdfText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  // verbosity 0: pdf.js otherwise prints font warnings to the host's console.
  const { text } = await extractText(await getDocumentProxy(data, { verbosity: 0 }), { mergePages: false })
  return joinPages(text)
}

export async function pdfFileText(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size > MAX_PDF_BYTES) throw new Error(`The PDF is ${String(Math.round(info.size / 1_048_576))} MB, more than this tool reads.`)
  return await pdfText(new Uint8Array(await readFile(path)))
}
