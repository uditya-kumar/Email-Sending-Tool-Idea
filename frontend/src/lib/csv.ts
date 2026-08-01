import Papa from "papaparse"
import { z } from "zod"
import { LEAD_EMAIL_PATTERN, type NewLead } from "@shared/leads.ts"
import { isValidIST } from "@shared/time.ts"
import type { Lead } from "./types"

/**
 * CSV import and export for the leads table.
 *
 * The import is validated rather than trusted. PapaParse hands back
 * `Record<string, string>` from a file the user picked, and every field of it maps
 * to a column with a CHECK constraint or a merge tag behind it. An unvalidated bad
 * email doesn't fail here — it fails as a 23514 on the insert (which, being one
 * statement for the whole file, takes the other 199 good rows down with it), or
 * worse it inserts and becomes a bounced send days later with no obvious cause.
 *
 * So the parse is total: every row comes back either as a `NewLead` that is known
 * to be insertable, or as a `RejectedRow` naming the line number and what was
 * wrong with it. The caller shows both.
 */

/** Defaults to mid-morning IST — a plausible cold-outreach hour, and the column's own default. */
const DEFAULT_SEND_TIME = "10:00"

/**
 * The validated shape of one CSV row, after loose header matching has already
 * resolved which column is which.
 *
 * Only `email` and `sendTimeIST` can fail. Everything else is a text column with a
 * `''` default in Postgres, so a blank cell is legitimately blank rather than an
 * error — a lead with no company name still sends, it just renders that merge
 * tag's fallback. Rejecting those rows would be stricter than the database and
 * lose leads the user could have fixed later in the grid.
 */
const csvLeadSchema = z.object({
  /*
   * Lowercased as well as trimmed. Addresses are case-insensitive in the part that
   * matters and the CHECK constraint is too, but the reply-detection and dedupe
   * paths compare strings — so "Jane@Acme.com" and "jane@acme.com" arriving from
   * two different exports must not become two leads.
   */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .regex(LEAD_EMAIL_PATTERN, "not a valid email address"),
  /*
   * Refined through the same helper the server and the lead dialog use, which is
   * stricter than Luxon alone: "24:00" parses as tomorrow's midnight but violates
   * `leads_send_time_ist_check`.
   */
  sendTimeIST: z
    .string()
    .refine(isValidIST, 'send time must be a 24-hour "HH:mm", e.g. "09:30"'),
  companyName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  personalizationLine: z.string(),
  /*
   * The two nullable columns, so a blank cell becomes NULL rather than `''`. The
   * distinction is visible: `leadColumns.tsx` renders a missing job title as "—"
   * and a missing website as no link at all, and `leadToRow` maps `undefined` to
   * null while `''` would be stored as an empty string.
   */
  jobTitle: z.string().transform((v) => v || undefined),
  website: z.string().transform((v) => v || undefined),
})

/** One row that couldn't be imported, and why. */
export interface RejectedRow {
  /**
   * The line in the file as the user's spreadsheet numbers it: the header is line
   * 1, so the first data row is 2. Reporting a zero-based index would send them
   * looking at the wrong row.
   */
  line: number
  /** The row's email if it had a recognisable one, for identifying it in the message. */
  email: string
  /** Human-readable reasons, one per failed field. */
  problems: string[]
}

export interface ParsedCsv {
  /** Rows that will insert. Ids come from Postgres, so these carry none. */
  leads: NewLead[]
  rejected: RejectedRow[]
}

/**
 * Parse an uploaded CSV. Column headers are matched loosely (case-insensitive,
 * ignoring spaces/underscores/dashes) so common export formats work without the
 * user renaming anything.
 *
 * Rejects only on a failure to *read* the file. A file full of invalid rows
 * resolves with `leads: []` and every row explained, because "your CSV is broken"
 * is far less useful than "row 14's email is missing an @".
 */
export function parseLeadsCsv(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const leads: NewLead[] = []
        const rejected: RejectedRow[] = []

        results.data.forEach((row, index) => {
          const parsed = csvLeadSchema.safeParse(candidateFromRow(row))

          if (parsed.success) {
            leads.push({ ...parsed.data, verification: "not_verified" })
            return
          }

          rejected.push({
            // +2, not +1: `index` is zero-based and line 1 is the header row.
            line: index + 2,
            email: pick(row, "email", "emailaddress"),
            problems: parsed.error.issues.map(describeIssue),
          })
        })

        resolve({ leads, rejected })
      },
      error: reject,
    })
  })
}

/**
 * A zod issue as a sentence a non-programmer can act on.
 *
 * Zod's own messages are field-relative ("not a valid email address"), so the
 * field name has to be prepended — except where the message already names it,
 * which is the case for the send time.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path[0]
  if (field === "sendTimeIST") return issue.message
  return field ? `${String(field)}: ${issue.message}` : issue.message
}

/**
 * Reduce a header to letters and digits so `Send Time (IST)`, `send_time_ist` and
 * `sendTime` are all the same key.
 *
 * Everything non-alphanumeric goes, not just spaces and separators. This used to
 * strip only `[\s_-]`, which left `Send Time (IST)` as `sendtime(ist)` — matching
 * no candidate, so every imported row silently took the 10:00 default instead of
 * its own send time. That header is the one `leadsToCsv` writes, so the Export
 * button's own file could not round-trip the column the whole feature exists for.
 */
function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function pick(row: Record<string, string>, ...candidates: string[]): string {
  const norm: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) norm[normalizeKey(k)] = v
  for (const c of candidates) {
    const val = norm[normalizeKey(c)]
    if (val != null && val !== "") return val.trim()
  }
  return ""
}

/**
 * Split a single-name column into first + last. Exports that only carry a whole
 * name still have to land in the two fields the table stores, so the first word
 * becomes the first name and whatever follows is the last.
 */
function splitName(name: string): { firstName: string; lastName: string } {
  const [first = "", ...rest] = name.trim().split(/\s+/)
  return { firstName: first, lastName: rest.join(" ") }
}

/**
 * Resolve one raw row into the field names `csvLeadSchema` validates.
 *
 * Header matching happens here rather than in the schema because it isn't
 * validation — it's the guesswork of deciding that a column called "Contact
 * Person" is the name. Keeping it separate means a rejected row's message talks
 * about `email`, not about whichever header the file happened to use.
 */
function candidateFromRow(row: Record<string, string>): Record<string, string> {
  const firstName = pick(row, "firstname", "givenname")
  const lastName = pick(row, "lastname", "surname", "familyname")

  // Only fall back to splitting a whole name when the row has no separate parts.
  const name =
    firstName || lastName
      ? { firstName, lastName }
      : splitName(pick(row, "fullname", "contactperson", "contactname", "name"))

  return {
    email: pick(row, "email", "emailaddress"),
    companyName: pick(row, "company", "companyname", "organization"),
    ...name,
    personalizationLine: pick(row, "personalization", "personalizationline", "note"),
    sendTimeIST: pick(row, "sendtime", "sendtimeist", "time") || DEFAULT_SEND_TIME,
    jobTitle: pick(row, "jobtitle", "title", "role"),
    website: pick(row, "website", "url", "domain"),
  }
}

/** Serialize leads back to a CSV string for the Export button. */
export function leadsToCsv(leads: Lead[]): string {
  return Papa.unparse(
    leads.map((l) => ({
      "Company Name": l.companyName,
      "First Name": l.firstName,
      "Last Name": l.lastName,
      "Email Address": l.email,
      "Personalization Line": l.personalizationLine,
      "Send Time (IST)": l.sendTimeIST,
      "Job Title": l.jobTitle ?? "",
      Website: l.website ?? "",
      Verification: l.verification,
      Status: l.status,
    }))
  )
}
