import { DateTime } from "luxon"
import type { Weekday } from "./types.ts"

export const IST_ZONE = "Asia/Kolkata"

/** The "HH:mm" 24-hour shape stored in `leads.send_time_ist`. */
export const IST_TIME_FORMAT = "HH:mm"

/**
 * The exact shape `leads.send_time_ist` accepts — a copy of that column's CHECK
 * constraint (`^([01][0-9]|2[0-3]):[0-5][0-9]$`).
 *
 * Needed because Luxon alone is more permissive than the database: it parses
 * "24:00" happily, rolling it over to 00:00 the next day, which the CHECK rejects.
 * Validating with Luxon only would let that value through every form and CSV
 * import and turn it into a 23514 at insert time — or, worse, a send silently
 * moved to the following day.
 */
const IST_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

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

/**
 * Format a UTC timestamp from the database for display in IST, e.g.
 * "2 Aug, 3:30 PM IST".
 *
 * The zone is forced rather than left to the browser: every other time in this
 * app is IST (each lead's send time is defined that way), and an open that reads
 * as 10:05 next to a send time of 09:30 is only comparable if both are the same
 * clock. `{ zone: "utc" }` covers a Postgres timestamp that arrived without an
 * offset — parsed as local it would be silently hours out.
 */
export function formatISTDateTime(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(IST_ZONE)
  if (!dt.isValid) return iso
  return `${dt.toFormat("d LLL, h:mm a")} IST`
}

/**
 * A UTC timestamp as a short IST calendar day + time, e.g. "Tue 4 Aug, 9:30 AM".
 *
 * The weekday is included on purpose: the scheduler skips days the settings
 * exclude, so "Tue" is what explains why a three-day wait landed four days out.
 * No "IST" suffix — this is for lines that already say it, unlike
 * `formatISTDateTime`.
 */
export function formatISTDayTime(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(IST_ZONE)
  if (!dt.isValid) return iso
  return dt.toFormat("ccc d LLL, h:mm a")
}

/**
 * A UTC timestamp as an IST time of day alone, e.g. "9:35 AM".
 *
 * Joined with a non-breaking space: this goes into narrow labels that are allowed
 * to wrap, and "9:35" on one line with "AM" on the next is unreadable in a way
 * that breaking anywhere else in the sentence is not.
 */
export function formatISTClock(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(IST_ZONE)
  if (!dt.isValid) return iso
  return `${dt.toFormat("h:mm")}\u00a0${dt.toFormat("a")}`
}

/**
 * A UTC timestamp as an IST calendar date: "5 Aug", or "21 Jul 2025" in another
 * year.
 *
 * The year appears only when it isn't the current one. Dropping it always would
 * be wrong in a tool that keeps history — "21 Jul" beside a sequence that ran
 * last summer is genuinely ambiguous — but printing it always makes every
 * ordinary near-future date four characters longer than it needs to be, in a
 * 16rem rail where that is the difference between one line and two.
 */
export function formatISTDay(iso: string, now: DateTime = DateTime.utc()): string {
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(IST_ZONE)
  if (!dt.isValid) return iso

  return dt.year === now.setZone(IST_ZONE).year
    ? dt.toFormat("d LLL")
    : dt.toFormat("d LLL yyyy")
}

/**
 * How many IST calendar days away a timestamp is: 0 today, 1 tomorrow, -3 three
 * days ago. `null` if it isn't a valid timestamp.
 *
 * Counted in **calendar days in IST**, not in elapsed hours, because that is how
 * the sequence is specified — "wait 3 days" means three dates later at the
 * recipient's own send time, and 09:30 tomorrow is "tomorrow" whether it is now
 * 23:00 or 08:00. Elapsed-hour rounding would call the same instant "in 10 hours"
 * or "in 2 days" depending on when you looked.
 */
export function istDayDelta(iso: string, now: DateTime = DateTime.utc()): number | null {
  const target = DateTime.fromISO(iso, { zone: "utc" }).setZone(IST_ZONE)
  if (!target.isValid) return null

  return target.startOf("day").diff(now.setZone(IST_ZONE).startOf("day"), "days").days
}

/** Format an IST "HH:mm" for display, e.g. "3:30 PM IST". */
export function formatIST(hhmm: string): string {
  const dt = DateTime.fromFormat(hhmm, IST_TIME_FORMAT, { zone: IST_ZONE })
  if (!dt.isValid) return hhmm
  return `${dt.toFormat("h:mm a")} IST`
}

/**
 * Validate a "HH:mm" 24-hour string, to the database's definition of valid.
 *
 * Both checks are deliberate: the pattern is what the `send_time_ist` CHECK
 * constraint enforces (and rules out Luxon's "24:00"), while Luxon rules out
 * anything the pattern would admit but no clock shows. Anything this accepts can
 * be inserted; anything it rejects would have failed at the database.
 */
export function isValidIST(hhmm: string): boolean {
  if (!IST_TIME_PATTERN.test(hhmm)) return false
  return DateTime.fromFormat(hhmm, IST_TIME_FORMAT, { zone: IST_ZONE }).isValid
}

/**
 * Split "HH:mm" into numbers, or `null` when it isn't a valid time of day.
 *
 * Returning `null` rather than throwing keeps the caller honest: a malformed
 * `send_time_ist` in the database must fail that one lead's send, not the tick.
 *
 * Uses `isValidIST` rather than Luxon alone, so this and every form validator agree
 * on what a time is. On Luxon's own terms `"24:00"` parses — it rolls over to 00:00
 * the next day — so this used to hand the scheduler midnight for it and move the
 * send 23h30m from where the value read. Unreachable in practice (the column CHECK
 * and every entry point reject it first), but "the one function that decides when an
 * email goes out silently reinterprets its input" is not a property worth keeping on
 * the strength of validation happening elsewhere.
 */
export function parseISTTime(hhmm: string): { hour: number; minute: number } | null {
  if (!isValidIST(hhmm)) return null

  const dt = DateTime.fromFormat(hhmm, IST_TIME_FORMAT, { zone: IST_ZONE })
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
