import * as cheerio from "cheerio"
import { renderTags } from "../../../shared/merge-tags.ts"
import type { Lead, SequenceStep } from "../../../shared/types.ts"
import { isTrackableUrl, trackingLinks, type TrackingLinks } from "../tracking/tracking-links.ts"

/**
 * One step + one lead → the exact subject, HTML and plain text that get sent.
 *
 * `renderTags` is imported from `shared/`, the same function the Preview step
 * calls. That is the single most important thing about this file: a second
 * server-side renderer would make the preview a guess rather than a guarantee.
 */

export interface RenderOptions {
  /** Append the 1×1 open pixel. Off by default — opens are noise (see CLAUDE.md). */
  trackOpens: boolean
  /** Rewrite `<a href>` through the signed click redirect. */
  trackClicks: boolean
  /**
   * Public id from the `sends` row, used in the pixel and click URLs. Omitted for
   * a test send, which deliberately carries no tracking at all — a test must not
   * pollute the recipient's event history.
   */
  trackingId?: string | undefined
  /**
   * The subject to use when the step deliberately leaves it blank.
   *
   * A follow-up that goes out as a reply in an existing thread has no subject of
   * its own — the compose UI says so ("leave it blank to send as a reply") — and
   * inherits the parent email's. Passed in rather than looked up here so this
   * file keeps its one job and stays database-free.
   *
   * Used **verbatim**, never through `renderTags`: it is already-rendered text,
   * and a second pass would re-interpret a `{{` that survived into the subject.
   */
  inheritedSubject?: string | undefined
}

export interface RenderedEmail {
  subject: string
  html: string
  /**
   * The `text/plain` alternative.
   *
   * Not optional: a multipart/alternative message with a real text part measurably
   * improves deliverability, and an HTML-only cold email is a spam signal.
   */
  text: string
}

/** A step that cannot be sent — an email step with nothing in it. */
export class EmptyStepError extends Error {
  override readonly name = "EmptyStepError"
}

export class EmailRenderer {
  constructor(private readonly tracking: TrackingLinks = trackingLinks) {}

  render(step: Pick<SequenceStep, "kind" | "subject" | "bodyHtml">, lead: Lead, options: RenderOptions): RenderedEmail {
    if (step.kind !== "email") {
      throw new EmptyStepError("Only an email step can be rendered; this one is a delay.")
    }

    const rawSubject = step.subject?.trim() ?? ""
    const rawBody = step.bodyHtml?.trim() ?? ""
    const inherited = options.inheritedSubject?.trim() ?? ""

    // Checked before rendering: after merge-tag substitution a body of nothing
    // but `{{first_name}}` would look non-empty while saying nothing.
    if (!rawSubject && !inherited) throw new EmptyStepError("This email has no subject.")
    if (!rawBody || !hasVisibleText(rawBody)) {
      throw new EmptyStepError("This email has an empty body.")
    }

    /*
     * `html: false` for the subject: it is plain text, and escaping an ampersand
     * there would put a literal "&amp;" in the recipient's inbox.
     *
     * The step's own subject wins when it has one — a follow-up is allowed to
     * change the subject, it just then starts its own thread, which is the
     * documented consequence of typing one in.
     */
    const subject = rawSubject ? renderTags(rawSubject, lead) : inherited
    let html = inlineParagraphStyles(renderTags(rawBody, lead, { html: true }))

    const trackingId = options.trackingId

    if (trackingId && options.trackClicks) {
      html = this.rewriteLinks(html, trackingId)
    }
    if (trackingId && options.trackOpens) {
      html += pixelTag(this.tracking.pixelUrl(trackingId))
    }

    return { subject, html, text: htmlToText(html) }
  }

  /**
   * Point every http(s) link at the signed click redirect.
   *
   * cheerio rather than a regex: Tiptap emits anchors with `target`, `rel` and
   * `class` attributes in whatever order, and a regex over `<a href="...">`
   * mangles them. This is also why the pixel is appended *after* rewriting —
   * cheerio would otherwise wrap the tracking URL in itself.
   */
  private rewriteLinks(html: string, trackingId: string): string {
    const $ = cheerio.load(html, null, false)

    $("a[href]").each((_i, element) => {
      const href = $(element).attr("href")
      if (!href || !isTrackableUrl(href)) return
      $(element).attr("href", this.tracking.wrap(href, trackingId))
    })

    return $.html()
  }
}

/**
 * Kill the mail client's default paragraph margin.
 *
 * Tiptap puts every line in its own `<p>`, and a mail client styles a bare `<p>`
 * with about `1em` top and bottom — so a message the user wrote as four
 * consecutive lines arrived with a blank line's worth of gap between each of them.
 * The editor had the same gap from its own stylesheet; that rule is now `margin: 0`
 * too (`.ProseMirror p` in `frontend/src/index.css`), and these two have to agree
 * or the compose window stops predicting the email.
 *
 * Done as an inline `style` because **email clients strip `<style>` blocks** —
 * Gmail's web client drops `<head>` entirely — so a stylesheet would fix the
 * preview and change nothing about what lands in the inbox.
 *
 * An empty paragraph is how Tiptap records a deliberate blank line, and a `<p>`
 * with no content collapses to zero height. It gets a `<br>` so the line the user
 * left blank survives.
 */
function inlineParagraphStyles(html: string): string {
  const $ = cheerio.load(html, null, false)

  $("p").each((_i, element) => {
    const p = $(element)
    // Appended to any existing style rather than replacing it: nothing sets one
    // today, but silently discarding a future inline style would be a bad trade
    // for one saved concatenation.
    const existing = p.attr("style")
    p.attr("style", existing ? `${existing};margin:0` : "margin:0")

    if (p.text().trim() === "" && p.children().length === 0) p.html("<br />")
  })

  return $.html()
}

function pixelTag(url: string): string {
  return `<img src="${url}" width="1" height="1" alt="" style="display:block" />`
}

/** Does this HTML contain anything a reader would see? */
function hasVisibleText(html: string): boolean {
  return cheerio.load(html, null, false).text().trim().length > 0
}

/**
 * A readable `text/plain` alternative from the HTML body.
 *
 * Hand-rolled rather than a dependency because the input is narrow — Tiptap emits
 * only paragraphs, lists, links and basic marks — and because a link needs its
 * URL spelled out in the text part, which most converters either drop or bury.
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html, null, false)

  // The pixel and any other image contribute nothing to a text reading.
  $("img, style, script").remove()

  // "click here (https://…)" — the URL has to survive, since a text-only reader
  // has no other way to reach it.
  $("a[href]").each((_i, element) => {
    const href = $(element).attr("href")
    const label = $(element).text().trim()
    if (!href) return
    $(element).replaceWith(label && label !== href ? `${label} (${href})` : href)
  })

  $("br").replaceWith("\n")

  /*
   * One newline per block, not two.
   *
   * Tiptap makes every line its own `<p>`, so a break per paragraph used to double
   * every line break in the text part — the same too-much-gap problem the HTML had,
   * except no CSS can fix it here. A blank line the user actually typed is an empty
   * paragraph, and `inlineParagraphStyles` has already given that its own `<br>`,
   * so deliberate gaps still come through.
   *
   * Headings and blockquotes keep the double break: those genuinely are separated
   * sections, and Tiptap can't emit a run of them one-per-line the way it does `<p>`.
   */
  $("p, div, li").each((_i, element) => {
    $(element).replaceWith(`${$(element).text()}\n`)
  })
  $("h1, h2, h3, h4, h5, h6, blockquote").each((_i, element) => {
    $(element).replaceWith(`${$(element).text()}\n\n`)
  })

  return $.text()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export const emailRenderer = new EmailRenderer()
