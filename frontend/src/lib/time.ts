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

/** Format an IST "HH:mm" without the zone suffix, e.g. "3:30 PM". */
function clockLabel(hhmm: string): string {
  const dt = DateTime.fromFormat(hhmm, "HH:mm", { zone: IST_ZONE })
  return dt.isValid ? dt.toFormat("h:mm a") : hhmm
}

/**
 * Quarter-hourly "HH:mm" options for the per-recipient send-time dropdown.
 * 15-minute steps because the seeded leads use times like 12:15 and 16:45.
 * Labels omit "IST" — the field is already labelled "Send time (IST)".
 */
export const SEND_TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const hhmm = `${String(Math.floor(i / 4)).padStart(2, "0")}:${String(
    (i % 4) * 15
  ).padStart(2, "0")}`
  return { value: hhmm, label: clockLabel(hhmm) }
})

/**
 * The dropdown options for one recipient. A lead whose time is off the 15-minute
 * grid (hand-typed, or imported from CSV) keeps its exact value as an extra
 * option, so opening the dropdown can never silently reschedule them.
 */
export function sendTimeOptions(
  current: string
): { value: string; label: string }[] {
  if (SEND_TIME_OPTIONS.some((o) => o.value === current)) return SEND_TIME_OPTIONS
  const extra = { value: current, label: clockLabel(current) }
  return [...SEND_TIME_OPTIONS, extra].sort((a, b) =>
    a.value.localeCompare(b.value)
  )
}
