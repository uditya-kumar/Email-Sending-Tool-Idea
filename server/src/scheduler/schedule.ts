/**
 * The scheduler's timing rules, plus the send loop's pacing.
 *
 * The arithmetic itself lives in `shared/schedule.ts` and is re-exported here
 * unchanged. It moved there when the compose sidebar started showing users *when*
 * each follow-up will go out: that projection has to agree with what this loop
 * actually does, and the only way to guarantee that is for both to call the same
 * function. A copy in the browser would have drifted the first time a rule changed.
 *
 * What stays server-side is everything meaningless to a projection — jitter and
 * sleep pace a real send loop; there is nothing to pace when drawing a sidebar.
 */
export {
  InvalidSendTimeError,
  NoAllowedDayError,
  daysFor,
  desiredFollowUpTime,
  firstSendAt,
  followUpSendAt,
  isAllowedDay,
  isStale,
  nextAllowedDay,
  projectSequenceSchedule,
  rescheduleStaleAt,
} from "../../../shared/schedule.ts"

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
