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

/** Hourly options ("HH:mm" value + "9:00 am" label) for the sending window. */
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const value = `${String(h).padStart(2, "0")}:00`
  const label = DateTime.fromObject({ hour: h }).toFormat("h:mm a").toLowerCase()
  return { value, label }
})

/** Current time in IST, e.g. "12:25 pm" (recomputed on each call). */
export function currentISTLabel(): string {
  return DateTime.now().setZone(IST_ZONE).toFormat("h:mm a").toLowerCase()
}

/** The last 7 calendar days (IST), oldest first, for the usage chart. */
export function lastSevenDays(): { iso: string; label: string }[] {
  const today = DateTime.now().setZone(IST_ZONE).startOf("day")
  return Array.from({ length: 7 }, (_, i) => {
    const d = today.minus({ days: 6 - i })
    return { iso: d.toISODate() ?? String(i), label: d.toFormat("LLL d") }
  })
}
