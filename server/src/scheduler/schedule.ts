import { DateTime } from "luxon"
import { IST_ZONE, parseISTTime, toWeekday } from "../../../shared/time.ts"
import type { Weekday } from "../../../shared/types.ts"

/**
 * All the IST/weekday/next-slot arithmetic, with no database and no Gmail in
 * sight — which is what makes it the one part of the scheduler that can be
 * reasoned about by reading it.
 *
 * Two rules the whole file exists to enforce:
 *  1. A send goes out at the lead's own IST time, on a day the settings allow.
 *  2. Nothing is ever scheduled in the past, so a launch always produces a real
 *     future slot rather than something the next tick fires immediately.
 *
 * Run the process with `TZ=UTC`. Every instant here is either explicitly IST or
 * explicitly UTC; the host's local zone is never consulted.
 */

/** A `send_time_ist` that isn't a valid 24-hour time. */
export class InvalidSendTimeError extends Error {
  override readonly name = "InvalidSendTimeError"
}

/** Settings have no eligible weekday at all, so nothing could ever be sent. */
export class NoAllowedDayError extends Error {
  override readonly name = "NoAllowedDayError"
}

/**
 * A week is the search bound: if no day in seven matches, the allowed set is
 * empty and advancing further would loop forever.
 */
const DAYS_IN_WEEK = 7

/** Move `at` forward to the first allowed weekday, keeping its time of day. */
export function nextAllowedDay(at: DateTime, allowedDays: readonly Weekday[]): DateTime {
  if (allowedDays.length === 0) {
    throw new NoAllowedDayError(
      "No sending days are enabled in settings, so nothing can be scheduled."
    )
  }

  let candidate = at.setZone(IST_ZONE)

  for (let offset = 0; offset < DAYS_IN_WEEK; offset += 1) {
    if (allowedDays.includes(toWeekday(candidate))) return candidate
    candidate = candidate.plus({ days: 1 })
  }

  /* istanbul ignore next — unreachable while allowedDays ⊆ Weekday */
  throw new NoAllowedDayError(
    `None of the next 7 days is in the allowed set [${allowedDays.join(", ")}].`
  )
}

/**
 * The IST slot for `sendTimeIst` on the day `at` falls on.
 *
 * Set on the IST-zoned copy, so 09:30 means 09:30 in Kolkata regardless of the
 * server's zone — this is where a naive `new Date().setHours()` would silently
 * schedule things five and a half hours off.
 */
function slotOn(at: DateTime, sendTimeIst: string): DateTime {
  const time = parseISTTime(sendTimeIst)

  if (!time) {
    throw new InvalidSendTimeError(
      `"${sendTimeIst}" is not a valid 24-hour IST time (expected "HH:mm").`
    )
  }

  return at.setZone(IST_ZONE).set({
    hour: time.hour,
    minute: time.minute,
    second: 0,
    millisecond: 0,
  })
}

/**
 * When a freshly launched lead's opening email should go out.
 *
 * "Today at 09:30" when it is 08:00 in India, tomorrow when it is already 10:00,
 * then forward to the next allowed outreach day. `now` is injectable so the
 * behaviour is testable without waiting for a Tuesday.
 */
export function firstSendAt(
  sendTimeIst: string,
  outreachDays: readonly Weekday[],
  now: DateTime = DateTime.utc()
): Date {
  const reference = now.setZone(IST_ZONE)
  let slot = slotOn(reference, sendTimeIst)

  // Strictly in the future: a slot exactly equal to now would be claimable by
  // the tick already running, which makes the launch response a lie.
  if (slot <= reference) slot = slot.plus({ days: 1 })

  return toDate(nextAllowedDay(slot, outreachDays))
}

/**
 * When follow-up N+1 should go out, given that N has just been sent.
 *
 * The delay counts from the **actual** send, not from the launch: that is what
 * makes "wait 3 days" mean three days after the recipient got the previous email,
 * however late that turned out to be.
 */
export function followUpSendAt(
  sentAt: Date,
  waitDays: number,
  sendTimeIst: string,
  followUpDays: readonly Weekday[],
  now: DateTime = DateTime.utc()
): Date {
  const base = DateTime.fromJSDate(sentAt, { zone: IST_ZONE }).plus({
    days: Math.max(waitDays, 0),
  })

  let slot = slotOn(base, sendTimeIst)
  const reference = now.setZone(IST_ZONE)

  /*
   * A zero-day wait, or a send that happened after its own slot, would otherwise
   * put the follow-up in the past and fire it on the very next tick — turning
   * "wait 0 days" into "send both emails within a minute of each other".
   */
  if (slot <= reference) slot = slotOn(reference.plus({ days: 1 }), sendTimeIst)

  return toDate(nextAllowedDay(slot, followUpDays))
}

/**
 * Where to move a send that is too old to deliver now.
 *
 * The next allowed day at the lead's usual time, never "right now": a laptop
 * closed over the weekend must not deliver Friday's 09:30 email at 02:00 on
 * Monday, which reads as a bot to both the recipient and Gmail.
 */
export function rescheduleStaleAt(
  sendTimeIst: string,
  allowedDays: readonly Weekday[],
  now: DateTime = DateTime.utc()
): Date {
  const reference = now.setZone(IST_ZONE)
  return toDate(nextAllowedDay(slotOn(reference.plus({ days: 1 }), sendTimeIst), allowedDays))
}

/**
 * Is this send so late that it should be rescheduled rather than sent?
 *
 * Deliberately one-sided — only lateness is checked. Being early is impossible
 * for a claimed row (the claim filters on `scheduled_at <= now()`).
 */
export function isStale(scheduledAt: Date, graceHours: number, now: Date = new Date()): boolean {
  const lateBy = now.getTime() - scheduledAt.getTime()
  return lateBy > graceHours * 60 * 60 * 1000
}

/** Which day set applies: opening emails and follow-ups are gated separately. */
export function daysFor(
  isFollowUp: boolean,
  settings: { outreachDays: Weekday[]; followUpDays: Weekday[] }
): Weekday[] {
  return isFollowUp ? settings.followUpDays : settings.outreachDays
}

/** Is `at` on a day this send is allowed to go out? */
export function isAllowedDay(at: Date, allowedDays: readonly Weekday[]): boolean {
  return allowedDays.includes(toWeekday(DateTime.fromJSDate(at, { zone: IST_ZONE })))
}

/**
 * `DateTime` → `Date`, refusing an invalid one.
 *
 * Luxon's `toJSDate()` on an invalid DateTime returns `Invalid Date`, whose
 * `toISOString()` throws — several layers away from the cause. Failing here names
 * the reason instead.
 */
function toDate(dt: DateTime): Date {
  if (!dt.isValid) {
    throw new InvalidSendTimeError(
      `Computed an invalid send time: ${dt.invalidReason ?? "unknown reason"}`
    )
  }
  return dt.toUTC().toJSDate()
}

/** Uniform random delay between two consecutive sends, in milliseconds. */
export function jitterMs(minSeconds: number, maxSeconds: number): number {
  const min = Math.max(minSeconds, 0)
  const max = Math.max(maxSeconds, min)
  return Math.round((min + Math.random() * (max - min)) * 1000)
}

/** `await sleep(ms)` — the jitter between sends inside one tick. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
