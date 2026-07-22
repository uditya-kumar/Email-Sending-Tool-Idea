import Papa from "papaparse"
import type { Lead, VerificationStatus } from "./types"

/**
 * Parse an uploaded CSV into Lead rows. Column headers are matched loosely
 * (case-insensitive, ignoring spaces/underscores) so common export formats work.
 */
export function parseLeadsCsv(file: File): Promise<Lead[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          resolve(results.data.map(rowToLead))
        } catch (err) {
          reject(err)
        }
      },
      error: reject,
    })
  })
}

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[\s_-]+/g, "")
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

let counter = 0
function rowToLead(row: Record<string, string>): Lead {
  counter += 1
  const email = pick(row, "email", "emailaddress")
  return {
    id: `csv-${counter}-${email || "row"}`,
    companyName: pick(row, "company", "companyname", "organization"),
    contactFullName:
      pick(row, "fullname", "contactperson", "contactname", "name") ||
      [pick(row, "firstname"), pick(row, "lastname")].filter(Boolean).join(" "),
    email,
    personalizationLine: pick(row, "personalization", "personalizationline", "note"),
    sendTimeIST: pick(row, "sendtime", "sendtimeist", "time") || "10:00",
    jobTitle: pick(row, "jobtitle", "title", "role") || undefined,
    website: pick(row, "website", "url", "domain") || undefined,
    verification: "not_verified" as VerificationStatus,
  }
}

/** Serialize leads back to a CSV string for the Export button. */
export function leadsToCsv(leads: Lead[]): string {
  return Papa.unparse(
    leads.map((l) => ({
      "Company Name": l.companyName,
      "Contact Person": l.contactFullName,
      "Email Address": l.email,
      "Personalization Line": l.personalizationLine,
      "Send Time (IST)": l.sendTimeIST,
      "Job Title": l.jobTitle ?? "",
      Website: l.website ?? "",
      Verification: l.verification,
    }))
  )
}
