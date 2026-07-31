import { DateTime } from "luxon"

const IST_ZONE = "Asia/Kolkata"

/**
 * Convert an IST "HH:mm" time (for today) into a UTC ISO string.
 * The scheduler on the server stores/dispatches in UTC.
 */
export function istTimeToUtcIso(hhmm: string, refDate = "2026-01-01"): string {
  const dt = DateTime.fromFormat(`${refDate} ${hhmm}`, "yyyy-MM-dd HH:mm", {
    zone: IST_ZONE,
  })
  return dt.toUTC().toISO() ?? ""
}

/** Format an IST "HH:mm" for display, e.g. "3:30 PM IST". */
export function formatIST(hhmm: string): string {
  const dt = DateTime.fromFormat(hhmm, "HH:mm", { zone: IST_ZONE })
  if (!dt.isValid) return hhmm
  return `${dt.toFormat("h:mm a")} IST`
}

/** Validate a "HH:mm" 24-hour string. */
export function isValidIST(hhmm: string): boolean {
  return DateTime.fromFormat(hhmm, "HH:mm", { zone: IST_ZONE }).isValid
}

/** Estimate reading time + word count for editor footer. */
export function readingStats(text: string): { words: number; seconds: number } {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const seconds = Math.round((words / 200) * 60) // ~200 wpm
  return { words, seconds }
}
