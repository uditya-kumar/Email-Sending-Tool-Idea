import type { Lead } from "./types.ts"

/**
 * The contact's name for display. A lead is stored as first + last name (that's
 * what a greeting needs), so anywhere that shows a whole name joins them here —
 * and tolerates either half being blank, since only the email is required.
 */
export function fullName(lead: Pick<Lead, "firstName" | "lastName">): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim()
}

/**
 * A lead as it is *created*, before Postgres and the scheduler have their say.
 *
 * Exactly `leadToRow`'s parameter, named because three callers now build one: the
 * lead dialog, the CSV importer, and the insert helpers. `id` is assigned by
 * Postgres; `status` and `repliedAt` belong to the scheduler, so a form able to
 * set them would be a bug.
 */
export type NewLead = Omit<Lead, "id" | "status" | "repliedAt">

/**
 * The email shape `leads.email` accepts — a copy of that column's CHECK
 * constraint (`^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$`, case-insensitive).
 *
 * Deliberately this permissive: it is not trying to be a better email validator
 * than the database, it is trying to be the *same* one. Anything this accepts can
 * be inserted, and anything it rejects would have come back as a 23514 — which,
 * for a CSV of 200 rows inserted in one statement, would fail all 200 without
 * saying which row was at fault.
 */
export const LEAD_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Validate an address to the database's definition of valid.
 *
 * Trims first because every entry point has whitespace in it somewhere — a
 * trailing space in a CSV cell, a copy-paste into the dialog — and a trimmed
 * value is what actually gets stored.
 */
export function isValidLeadEmail(email: string): boolean {
  return LEAD_EMAIL_PATTERN.test(email.trim())
}
