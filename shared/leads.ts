import type { Lead } from "./types.ts"

/**
 * The contact's name for display. A lead is stored as first + last name (that's
 * what a greeting needs), so anywhere that shows a whole name joins them here —
 * and tolerates either half being blank, since only the email is required.
 */
export function fullName(lead: Pick<Lead, "firstName" | "lastName">): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim()
}
