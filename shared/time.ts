import { DateTime } from "luxon"
import type { Weekday } from "./types.ts"

export const IST_ZONE = "Asia/Kolkata"

/** The "HH:mm" 24-hour shape stored in `leads.send_time_ist`. */
export const IST_TIME_FORMAT = "HH:mm"

/**
 * Convert an IST "HH:mm" time (on `refDate`) into a UTC ISO string.
 * The scheduler stores and dispatches in UTC.
 */
export function istTimeToUtcIso(hhmm: string, refDate = "2026-01-01"): string {
  const dt = DateTime.fromFormat(`${refDate} ${hhmm}`, "yyyy-MM-dd HH:mm", {
    zone: IST_ZONE,
  })
  return dt.toUTC().toISO() ?? ""
}

/** Format an IST "HH:mm" for display, e.g. "3:30 PM IST". */
export function formatIST(hhmm: string): string {
  const dt = DateTime.fromFormat(hhmm, IST_TIME_FORMAT, { zone: IST_ZONE })
  if (!dt.isValid) return hhmm
  return `${dt.toFormat("h:mm a")} IST`
}

/** Validate a "HH:mm" 24-hour string. */
export function isValidIST(hhmm: string): boolean {
  return DateTime.fromFormat(hhmm, IST_TIME_FORMAT, { zone: IST_ZONE }).isValid
}

/**
 * Split "HH:mm" into numbers, or `null` when it isn't a valid time of day.
 *
 * Returning `null` rather than throwing keeps the caller honest: a malformed
 * `send_time_ist` in the database must fail that one lead's send, not the tick.
 */
export function parseISTTime(hhmm: string): { hour: number; minute: number } | null {
  const dt = DateTime.fromFormat(hhmm, IST_TIME_FORMAT, { zone: IST_ZONE })
  if (!dt.isValid) return null
  return { hour: dt.hour, minute: dt.minute }
}

/**
 * Luxon numbers weekdays 1 = Monday … 7 = Sunday; the `Weekday` type used by
 * `outreachDays` / `followUpDays` is 0 = Monday … 6 = Sunday. Every conversion
 * goes through here so the off-by-one can only be wrong in one place.
 */
export function toWeekday(dt: DateTime): Weekday {
  return (dt.weekday - 1) as Weekday
}

/** Estimate reading time + word count for editor footer. */
export function readingStats(text: string): { words: number; seconds: number } {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const seconds = Math.round((words / 200) * 60) // ~200 wpm
  return { words, seconds }
}
