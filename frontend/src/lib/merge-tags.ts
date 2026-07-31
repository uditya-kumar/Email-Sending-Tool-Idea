import type { Lead, MergeAttribute, MergeAttributeKey } from "./types"

/**
 * Merge-tag syntax (Hunter-style):  {{key:"fallback"}}  or  {{key}}
 * e.g.  {{first_name:"there"}}   {{company:"your company"}}
 */

export const MERGE_ATTRIBUTES: MergeAttribute[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "job_title", label: "Job title" },
  { key: "personalization", label: "Personalization line" },
]

const ATTRIBUTE_LABELS: Record<MergeAttributeKey, string> =
  Object.fromEntries(MERGE_ATTRIBUTES.map((a) => [a.key, a.label])) as Record<
    MergeAttributeKey,
    string
  >

/** Matches {{key}} or {{key:"fallback"}} (fallback may use single/double quotes). */
const TAG_RE = /\{\{\s*([a-z_]+)\s*(?::\s*["']([^"']*)["']\s*)?\}\}/gi

/** Build the tag string that gets inserted into the editor/template. */
export function buildTag(key: MergeAttributeKey, fallback: string): string {
  return fallback ? `{{${key}:"${fallback}"}}` : `{{${key}}}`
}

/** Resolve a single attribute key to a lead's value (empty string if none). */
function valueForKey(key: string, lead: Lead): string {
  const [first = "", ...rest] = lead.contactFullName.trim().split(/\s+/)
  const last = rest.join(" ")
  switch (key as MergeAttributeKey) {
    case "first_name":
      return first
    case "last_name":
      return last
    case "full_name":
      return lead.contactFullName
    case "company":
      return lead.companyName
    case "email":
      return lead.email
    case "job_title":
      return lead.jobTitle ?? ""
    case "personalization":
      return lead.personalizationLine
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
    const resolved = valueForKey(key, lead) || fallback ||
      ATTRIBUTE_LABELS[key as MergeAttributeKey] || key
    return html ? toHtmlValue(resolved) : resolved
  })
}

/**
 * Replace merge tags with styled <span class="merge-tag"> pills so the raw
 * template (no specific recipient) reads nicely in the editor preview.
 */
export function renderTagsAsPills(html: string): string {
  return html.replace(TAG_RE, (_m, key: string, fallback?: string) => {
    const label = ATTRIBUTE_LABELS[key as MergeAttributeKey] ?? key
    const suffix = fallback ? ` · ${fallback}` : ""
    return `<span class="merge-tag">${label}${suffix}</span>`
  })
}

/** Count how many merge tags a template contains. */
export function countTags(text: string): number {
  return (text.match(TAG_RE) ?? []).length
}
