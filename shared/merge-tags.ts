import { fullName } from "./leads.ts"
import { formatIST } from "./time.ts"
import type { Lead, MergeAttribute } from "./types.ts"

/**
 * Merge-tag syntax (Hunter-style):  {{key:"fallback"}}  or  {{key}}
 * e.g.  {{first_name:"there"}}   {{company:"your company"}}
 *
 * ⚠️ This module is imported by **both** the Preview step and the server's
 * renderer. That is deliberate and load-bearing: a second implementation on the
 * server would make the preview lie about what actually gets sent. Change it
 * here or not at all.
 */

/**
 * One attribute per data column of the Database table, in the same order and
 * with the same labels — a template can only merge what a lead actually stores,
 * so the picker and the table must not drift apart. (`select`, `Status` and
 * `Actions` are excluded: they're table chrome and workflow state, not recipient
 * data you'd write into an email.)
 */
/**
 * Typed as a non-empty tuple (`[MergeAttribute, ...MergeAttribute[]]`) rather
 * than `MergeAttribute[]` so that under `noUncheckedIndexedAccess` the first
 * element is known to exist. The attribute picker defaults to `[0]`, and a
 * hand-written constant list is exactly the case where the compiler's "an index
 * might be out of bounds" doubt is noise — encoding non-emptiness in the type is
 * what removes it, rather than a `!` at each call site.
 */
export const MERGE_ATTRIBUTES: [MergeAttribute, ...MergeAttribute[]] = [
  { key: "email", label: "Email address" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "company", label: "Company" },
  { key: "personalization", label: "Personalization line" },
  { key: "job_title", label: "Job title" },
  { key: "website", label: "Website" },
  { key: "send_time", label: "Send time (IST)" },
]

/**
 * Tags the picker no longer offers but that still resolve, so templates written
 * before the list was aligned to the Database columns keep rendering correctly.
 */
const LEGACY_LABELS: Record<string, string> = {
  full_name: "Contact person",
}

const ATTRIBUTE_LABELS: Record<string, string> = {
  ...LEGACY_LABELS,
  ...Object.fromEntries(MERGE_ATTRIBUTES.map((a) => [a.key, a.label])),
}

/** Matches {{key}} or {{key:"fallback"}} (fallback may use single/double quotes). */
const TAG_RE = /\{\{\s*([a-z_]+)\s*(?::\s*["']([^"']*)["']\s*)?\}\}/gi

/**
 * A fresh copy of the tag pattern. `TAG_RE` is global, so it carries `lastIndex`
 * between calls — anything scanning with `exec` in a loop (e.g. the editor's tag
 * decorations) needs its own instance rather than the shared one.
 */
export function tagRegex(): RegExp {
  return new RegExp(TAG_RE.source, TAG_RE.flags)
}

/** Build the tag string that gets inserted into the editor/template. */
export function buildTag(key: string, fallback: string): string {
  return fallback ? `{{${key}:"${fallback}"}}` : `{{${key}}}`
}

/** Resolve a single attribute key to a lead's value (empty string if none). */
function valueForKey(key: string, lead: Lead): string {
  switch (key) {
    case "email":
      return lead.email
    case "first_name":
      return lead.firstName
    case "last_name":
      return lead.lastName
    case "company":
      return lead.companyName
    case "personalization":
      return lead.personalizationLine
    case "job_title":
      return lead.jobTitle ?? ""
    case "website":
      return lead.website ?? ""
    case "send_time":
      return formatIST(lead.sendTimeIST)
    // Retired from the picker; still resolved for older templates.
    case "full_name":
      return fullName(lead)
    default:
      return ""
  }
}

/**
 * Prepare a substituted value for injection into HTML: escape it (values are
 * free-text lead data, not markup) and keep the author's line breaks, which
 * matter because the personalization line can span several lines.
 *
 * Quotes are escaped as well as angle brackets, because a tag is not always in
 * text position. A template may legitimately put one in an **attribute** — typing
 * `{{website}}` into Tiptap's link dialog gives `<a href="{{website}}">` — and there
 * a value containing `"` closes the attribute early: a website of
 * `https://x.com" style="display:none` rendered a link that silently didn't show,
 * and anything after the quote became markup rather than part of the URL. Escaping
 * here rather than at the one call site keeps every context safe by default, which
 * matters because lead data arrives by CSV import and nobody eyeballs 200 rows.
 */
function toHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r\n|\r|\n/g, "<br>")
}

/**
 * Substitute all merge tags in `text` with values from `lead`,
 * falling back to the tag's fallback (or the attribute label) when empty.
 *
 * Pass `{ html: true }` when the result is injected as HTML (the email body) so
 * substituted values get escaped and their newlines become `<br>`. Leave it off
 * for plain-text contexts like the subject line.
 */
export function renderTags(
  text: string,
  lead: Lead,
  { html = false }: { html?: boolean } = {}
): string {
  return text.replace(TAG_RE, (_m, key: string, fallback?: string) => {
    /*
     * Trimmed before the emptiness test, so a cell holding only spaces counts as
     * missing and the fallback applies. Untrimmed, `" " || fallback` is `" "` —
     * truthy — and `Hi {{first_name:"there"}},` rendered as `Hi    ,` on a lead whose
     * first-name column was blank-but-not-empty. CSV import makes that the common
     * shape rather than a rare one: a trailing comma, a padded column, or a
     * spreadsheet export all produce it, and the fallback the user wrote precisely to
     * cover a missing name is the thing that gets skipped.
     */
    const resolved =
      valueForKey(key, lead).trim() || fallback || ATTRIBUTE_LABELS[key] || key
    return html ? toHtmlValue(resolved) : resolved
  })
}

/**
 * Replace merge tags with styled <span class="merge-tag"> pills so the raw
 * template (no specific recipient) reads nicely in the editor preview.
 */
export function renderTagsAsPills(html: string): string {
  return html.replace(TAG_RE, (_m, key: string, fallback?: string) => {
    const label = ATTRIBUTE_LABELS[key] ?? key
    const suffix = fallback ? ` · ${fallback}` : ""
    return `<span class="merge-tag">${label}${suffix}</span>`
  })
}

/** Count how many merge tags a template contains. */
export function countTags(text: string): number {
  return (text.match(TAG_RE) ?? []).length
}

/**
 * The attribute labels in `text` that this lead has **no value and no fallback**
 * for — the tags that will render as their own label.
 *
 * This exists because of how bad that output looks in a real cold email:
 * `Hi {{first_name}},` on a lead with a blank first name renders as
 * **"Hi First name,"**, and `at {{company}}` as **"at Company"**. It is grammatical,
 * so it doesn't read as a bug at a glance — it reads as a mail-merge that misfired,
 * which is worse than an obvious blank.
 *
 * The label is kept as the last resort rather than substituting an empty string,
 * because `Hi ,` is not an improvement and a silent gap hides the problem instead of
 * showing it. What was missing was any *warning*, so the preview asks this and says
 * so before Launch — the one screen where it can still be fixed by typing a fallback
 * or filling the cell in.
 *
 * Deduplicated and in template order. Empty means every tag resolves to something
 * the author chose.
 */
export function unresolvedTagLabels(text: string, lead: Lead): string[] {
  const labels: string[] = []

  for (const match of text.matchAll(tagRegex())) {
    const key = match[1]
    const fallback = match[2]
    if (!key || fallback) continue
    // Same trim as `renderTags`, or a whitespace-only cell would look resolved here
    // and render as a gap there.
    if (valueForKey(key, lead).trim()) continue

    const label = ATTRIBUTE_LABELS[key] ?? key
    if (!labels.includes(label)) labels.push(label)
  }

  return labels
}
