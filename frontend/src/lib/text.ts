/**
 * Word counts for composed email bodies.
 *
 * Display-only — nothing about a send reads these — so they live here rather
 * than in `shared/`.
 */

/** Words in a block of plain text. */
export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/** Elements whose edges are word boundaries in the rendered email. */
const BLOCKS = "p, br, li, ul, ol, div, blockquote, pre, h1, h2, h3, h4, h5, h6"

/**
 * Words a reader would see in a block of email HTML.
 *
 * A space is inserted at every block edge before the tags are dropped, because
 * Tiptap emits one `<p>` per line and a bare `textContent` would glue them
 * together — "Best,Uditya Kumar Pandey" counts as two words where the inbox
 * shows four.
 *
 * Link *text* counts and the href does not, which is what Tiptap's own
 * `getText()` reports on the Content tab, so the two counts measure the same
 * thing. They will still differ, and should: the Content tab counts
 * `{{personalization}}` as one word, and this counts the sentence it resolves
 * to for this recipient.
 */
export function countHtmlWords(html: string): number {
  const doc = new DOMParser().parseFromString(html, "text/html")
  doc.body.querySelectorAll(BLOCKS).forEach((el) => el.after(" "))
  return countWords(doc.body.textContent ?? "")
}
