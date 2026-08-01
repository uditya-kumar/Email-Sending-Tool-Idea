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

    // Checked before rendering: after merge-tag substitution a body of nothing
    // but `{{first_name}}` would look non-empty while saying nothing.
    if (!rawSubject) throw new EmptyStepError("This email has no subject.")
    if (!rawBody || !hasVisibleText(rawBody)) {
      throw new EmptyStepError("This email has an empty body.")
    }

    // `html: false` for the subject: it is plain text, and escaping an ampersand
    // there would put a literal "&amp;" in the recipient's inbox.
    const subject = renderTags(rawSubject, lead)
    let html = renderTags(rawBody, lead, { html: true })

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
  // Block elements become paragraph breaks; without this every paragraph runs
  // into the next one.
  $("p, div, li, h1, h2, h3, h4, h5, h6, blockquote").each((_i, element) => {
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
