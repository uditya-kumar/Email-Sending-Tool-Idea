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
 */
function toHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
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
    const resolved =
      valueForKey(key, lead) || fallback || ATTRIBUTE_LABELS[key] || key
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
