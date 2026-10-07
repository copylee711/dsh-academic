/**
 * Text that came from a library or the web is data for the model, never
 * instructions. It is fenced so a title or an abstract cannot pose as one.
 */

const OPEN = '<untrusted-external-content>'
const CLOSE = '</untrusted-external-content>'

export function untrusted(text: string): string {
  // A fence inside the text would end the real one early.
  const body = text.replaceAll(OPEN, '').replaceAll(CLOSE, '')
  return `${OPEN}\n${body}\n${CLOSE}`
}
