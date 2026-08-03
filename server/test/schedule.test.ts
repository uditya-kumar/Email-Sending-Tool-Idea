import test from "node:test"
import assert from "node:assert/strict"
import { DateTime } from "luxon"
import {
  InvalidSendTimeError,
  NoAllowedDayError,
  daysFor,
  desiredFollowUpTime,
  firstSendAt,
  followUpSendAt,
  isAllowedDay,
  isStale,
  nextAllowedDay,
  rescheduleStaleAt,
} from "../../shared/schedule.ts"
import { IST_ZONE, toWeekday } from "../../shared/time.ts"
import type { Weekday } from "../../shared/types.ts"

/**
 * The timing arithmetic, exhaustively — every rule that decides **when** a
 * prospect's email goes out.
 *
 * This is pure-function territory (no database, no Gmail), which is exactly why it
 * can be tested exhaustively rather than by example, and several of these assert a
 * *universal* property over a whole week or a whole day of minutes rather than one
 * hand-picked instant. That matters because the failures this file is guarding
 * against are the ones nobody would think to pick: 00:00 as a send time, a wait
 * that lands on the one excluded weekday, a lead launched in the same minute as
 * their own slot.
 *
 * Two invariants everything here serves:
 *
 *  1. **Nothing is ever scheduled in the past.** A row dated in the past is claimed
 *     by the very next tick and fires immediately — at 02:00, from a laptop that
 *     was closed, which is what a bot looks like to both Gmail and the recipient.
 *  2. **A send lands on the recipient's own IST time, on an allowed day.** Not
 *     "roughly then": at that minute, in Asia/Kolkata, regardless of the server's
 *     zone.
 *
 * `now` is injected everywhere rather than mocked, because these functions were
 * written to take it — which is the reason a Tuesday-only rule can be tested on a
 * Friday.
 */

/** Mon–Thu, the production outreach set (`DEPLOY-BACKEND.md` step 12). */
const MON_THU: Weekday[] = [0, 1, 2, 3]
/** Mon–Fri, the production follow-up set. */
const MON_FRI: Weekday[] = [0, 1, 2, 3, 4]
const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6]

/** An IST instant, spelled out so each test reads as a wall clock in Kolkata. */
function ist(iso: string): DateTime {
  const dt = DateTime.fromISO(iso, { zone: IST_ZONE })
  assert.ok(dt.isValid, `bad test fixture: ${iso}`)
  return dt
}

/** What a returned UTC `Date` looks like on an IST wall clock. */
function asIST(at: Date): string {
  return DateTime.fromJSDate(at, { zone: IST_ZONE }).toFormat("ccc yyyy-MM-dd HH:mm")
}

// ── firstSendAt — the opening email's slot ────────────────────────────────────

test("firstSendAt: before the slot today, it goes out today", () => {
  // 08:00 IST on a Monday, lead's time 09:30 → an hour and a half from now.
  const at = firstSendAt("09:30", ALL_DAYS, ist("2026-08-03T08:00"))
  assert.equal(asIST(at), "Mon 2026-08-03 09:30")
})

test("firstSendAt: after the slot, it goes out tomorrow — never today in the past", () => {
  const at = firstSendAt("09:30", ALL_DAYS, ist("2026-08-03T10:00"))
  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
})

test("firstSendAt: launching *in* the slot's own minute waits for tomorrow", () => {
  /*
   * The boundary the `slot <= reference` test exists for. A slot exactly equal to
   * now is claimable by the tick that may already be running (`scheduled_at <=
   * now()`), so returning it would make the launch response a lie — the toast would
   * promise 09:30 tomorrow while the email left in the next few seconds.
   */
  const at = firstSendAt("09:30", ALL_DAYS, ist("2026-08-03T09:30:00.000"))
  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
})

test("firstSendAt: one second past the slot is still tomorrow", () => {
  const at = firstSendAt("09:30", ALL_DAYS, ist("2026-08-03T09:30:01.000"))
  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
})

test("firstSendAt: one second *before* the slot still gets today", () => {
  const at = firstSendAt("09:30", ALL_DAYS, ist("2026-08-03T09:29:59.000"))
  assert.equal(asIST(at), "Mon 2026-08-03 09:30")
})

test("firstSendAt: a Friday launch on a Mon–Thu schedule waits for Monday", () => {
  // 2026-08-07 is a Friday. Sat/Sun are excluded too, so the answer is the 10th.
  const at = firstSendAt("09:30", MON_THU, ist("2026-08-07T08:00"))
  assert.equal(asIST(at), "Mon 2026-08-10 09:30")
})

test("firstSendAt: Thursday after the slot rolls past the weekend, not to Friday", () => {
  // Thu 10:00, slot already gone → tomorrow is Friday, which Mon–Thu excludes.
  const at = firstSendAt("09:30", MON_THU, ist("2026-08-06T10:00"))
  assert.equal(asIST(at), "Mon 2026-08-10 09:30")
})

test("firstSendAt: the server's own zone is never consulted", () => {
  /*
   * The same instant expressed in three zones must give one answer. This is the
   * regression guard for a `new Date().setHours()`-shaped mistake, which would put
   * every send 5h30m out and only on a non-UTC host — i.e. not on CI.
   */
  const instant = "2026-08-03T02:30:00Z" // 08:00 IST
  const answers = ["utc", "America/New_York", "Australia/Sydney"].map((zone) =>
    firstSendAt("09:30", ALL_DAYS, DateTime.fromISO(instant, { zone })).toISOString()
  )

  assert.equal(new Set(answers).size, 1, `zone leaked into the answer: ${answers.join(" ")}`)
  assert.equal(asIST(new Date(answers[0]!)), "Mon 2026-08-03 09:30")
})

test("firstSendAt: midnight and 23:59 are ordinary send times", () => {
  // The two ends of the CHECK constraint's range, which off-by-one arithmetic
  // around "the next day" is most likely to get wrong.
  assert.equal(
    asIST(firstSendAt("00:00", ALL_DAYS, ist("2026-08-03T23:00"))),
    "Tue 2026-08-04 00:00"
  )
  assert.equal(
    asIST(firstSendAt("23:59", ALL_DAYS, ist("2026-08-03T00:01"))),
    "Mon 2026-08-03 23:59"
  )
})

test("firstSendAt: every minute of a day yields a future slot on an allowed day", () => {
  /*
   * The property, over all 1440 minutes of a day × a Mon–Thu week. Stated as a
   * property because invariant 1 has no exceptions: if any (now, sendTime) pair
   * produces a past instant, the next tick fires it immediately.
   */
  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    for (let minute = 0; minute < 1440; minute += 1) {
      const now = ist("2026-08-03T00:00").plus({ days: dayOffset, minutes: minute })
      const sendTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`

      const at = firstSendAt(sendTime, MON_THU, now)
      const landed = DateTime.fromJSDate(at, { zone: IST_ZONE })

      assert.ok(at.getTime() > now.toMillis(), `${sendTime} at ${now.toISO()} landed in the past`)
      assert.ok(MON_THU.includes(toWeekday(landed)), `${landed.toISO()} is not an allowed day`)
      assert.equal(landed.toFormat("HH:mm"), sendTime, "landed at the wrong time of day")
    }
  }
})

// ── followUpSendAt — the wait between emails ──────────────────────────────────

test("followUpSendAt: a 3-day wait counts from the actual send", () => {
  // Sent Mon 09:31 (a minute late), wait 3 → Thu 09:30, not "3 days from launch".
  const at = followUpSendAt(
    ist("2026-08-03T09:31").toJSDate(),
    3,
    "09:30",
    MON_FRI,
    ist("2026-08-03T09:31")
  )
  assert.equal(asIST(at), "Thu 2026-08-06 09:30")
})

test("followUpSendAt: a 0-day wait never sends both emails in the same minute", () => {
  /*
   * The `slot <= reference` guard. Without it, "wait 0 days" put the follow-up at
   * today's slot — already past, since the opening email just went out at it — and
   * the very next tick delivered a second email one minute after the first.
   */
  const sentAt = ist("2026-08-03T09:30").toJSDate()
  const at = followUpSendAt(sentAt, 0, "09:30", ALL_DAYS, ist("2026-08-03T09:30"))

  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
  assert.ok(at.getTime() - sentAt.getTime() >= 23 * 3600e3, "must be about a day apart, not minutes")
})

test("followUpSendAt: a negative wait is clamped, not treated as the past", () => {
  const at = followUpSendAt(
    ist("2026-08-03T09:30").toJSDate(),
    -5,
    "09:30",
    ALL_DAYS,
    ist("2026-08-03T09:30")
  )
  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
})

test("followUpSendAt: a send that ran late still gets a future slot", () => {
  // Delivered at 23:00 after a backlog; a 1-day wait must not land at 09:30 on a
  // day that has already begun.
  const at = followUpSendAt(
    ist("2026-08-03T23:00").toJSDate(),
    0,
    "09:30",
    ALL_DAYS,
    ist("2026-08-03T23:00")
  )
  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
})

test("followUpSendAt: a wait landing on an excluded day rolls forward", () => {
  // Sent Wed, wait 3 → Sat, which Mon–Fri excludes → Monday.
  const at = followUpSendAt(
    ist("2026-08-05T09:30").toJSDate(),
    3,
    "09:30",
    MON_FRI,
    ist("2026-08-05T09:30")
  )
  assert.equal(asIST(at), "Mon 2026-08-10 09:30")
})

test("followUpSendAt: a stale parent send is re-based on *now*, not on the past", () => {
  /*
   * The scenario a resync or a re-derived projection hits: the parent went out ten
   * days ago and `waitDays` has long since elapsed. The naive answer (sentAt +
   * waitDays) is in the past and would fire on the next tick.
   */
  const at = followUpSendAt(
    ist("2026-07-20T09:30").toJSDate(),
    3,
    "09:30",
    ALL_DAYS,
    ist("2026-08-03T14:00")
  )
  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
})

test("followUpSendAt: a follow-up is never scheduled before its parent", () => {
  // The property over a fortnight of send instants × waits 0–7. Ordering is the
  // one thing a recipient reads directly: #2 arriving before #1 is incoherent.
  for (let hour = 0; hour < 24 * 14; hour += 7) {
    const sentAt = ist("2026-08-03T00:00").plus({ hours: hour })

    for (let wait = 0; wait <= 7; wait += 1) {
      const at = followUpSendAt(sentAt.toJSDate(), wait, "09:30", MON_FRI, sentAt)

      assert.ok(
        at.getTime() > sentAt.toMillis(),
        `wait ${wait} from ${sentAt.toISO()} landed at or before the parent`
      )
      assert.ok(
        MON_FRI.includes(toWeekday(DateTime.fromJSDate(at, { zone: IST_ZONE }))),
        `wait ${wait} from ${sentAt.toISO()} landed on an excluded day`
      )
    }
  }
})

test("followUpSendAt: a chained sequence is strictly increasing and correctly spaced", () => {
  // Three emails, waits 3 and 3, on a Mon–Fri schedule — the default sequence.
  const first = ist("2026-08-03T09:30") // Monday
  const second = followUpSendAt(first.toJSDate(), 3, "09:30", MON_FRI, first)
  const third = followUpSendAt(second, 3, "09:30", MON_FRI, DateTime.fromJSDate(second))

  assert.equal(asIST(second), "Thu 2026-08-06 09:30")
  // Thu + 3 = Sunday, excluded → Monday.
  assert.equal(asIST(third), "Mon 2026-08-10 09:30")
  assert.ok(second.getTime() < third.getTime())
})

// ── rescheduleStaleAt — the alternate-day dead zone (bug #1) ──────────────────

test("rescheduleStaleAt: a row claimed just after IST midnight gets *today's* slot", () => {
  /*
   * Bug #1's exact reproduction. This used to add a day unconditionally, so a row
   * left over from a capped day was claimed at 00:01, judged ~14h late, and pushed
   * to the day *after* the morning it was already waiting for.
   */
  const at = rescheduleStaleAt("09:30", ALL_DAYS, ist("2026-08-04T00:01"))
  assert.equal(asIST(at), "Tue 2026-08-04 09:30")
})

test("rescheduleStaleAt: a 20-follow-up backlog drains 10 a day, not 10/0/10/0", () => {
  /*
   * The consequence, simulated: each day the tick sends `cap` and reschedules the
   * rest, which the next post-midnight tick picks up. The old behaviour lost every
   * second day, so the tail of a backlog ran a day further behind its own send
   * time with each round.
   */
  const cap = 10
  let pending = 20
  const drained: number[] = []

  for (let day = 0; day < 4 && pending > 0; day += 1) {
    // The first tick after IST midnight, which is when the leftovers are claimed.
    const now = ist("2026-08-04T00:01").plus({ days: day })
    const movedTo = rescheduleStaleAt("09:30", ALL_DAYS, now)
    const sameDay = DateTime.fromJSDate(movedTo, { zone: IST_ZONE }).hasSame(now, "day")

    // A row moved to today still goes out today; moved to tomorrow, the day is dead.
    const sent = sameDay ? Math.min(cap, pending) : 0
    pending -= sent
    drained.push(sent)
  }

  assert.deepEqual(drained, [10, 10], "the backlog must drain on consecutive days")
})

test("rescheduleStaleAt: after the slot it moves to the next allowed day", () => {
  const at = rescheduleStaleAt("09:30", ALL_DAYS, ist("2026-08-04T14:00"))
  assert.equal(asIST(at), "Wed 2026-08-05 09:30")
})

test("rescheduleStaleAt: never returns 'right now', however late the row is", () => {
  /*
   * The weekend-laptop case. A Friday 09:30 email must not be delivered at 02:00 on
   * Monday when the machine wakes up — that timestamp is itself a bot signal, and
   * it also breaks the promise the recipient's own send time makes.
   */
  const now = ist("2026-08-10T02:00") // Monday, small hours
  const at = rescheduleStaleAt("09:30", MON_THU, now)

  assert.equal(asIST(at), "Mon 2026-08-10 09:30")
  assert.ok(at.getTime() - now.toMillis() > 7 * 3600e3, "must wait for the real slot")
})

test("rescheduleStaleAt: agrees with firstSendAt on the same inputs", () => {
  /*
   * They share `nextFutureSlot`, and this asserts they keep sharing it: "when is
   * the next real chance to send this" is one question, and the two answering it
   * differently *was* bug #1.
   */
  for (let hour = 0; hour < 24; hour += 1) {
    const now = ist("2026-08-03T00:00").plus({ hours: hour })
    assert.equal(
      rescheduleStaleAt("09:30", MON_THU, now).toISOString(),
      firstSendAt("09:30", MON_THU, now).toISOString(),
      `diverged at ${now.toISO()}`
    )
  }
})

// ── isStale — the grace window ────────────────────────────────────────────────

test("isStale: only lateness counts, and only past the grace window", () => {
  const now = new Date("2026-08-03T09:30:00Z")
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600e3)

  assert.equal(isStale(hoursAgo(5), 6, now), false, "5h late is inside a 6h grace")
  assert.equal(isStale(hoursAgo(6), 6, now), false, "exactly at the boundary is not stale")
  assert.equal(isStale(hoursAgo(7), 6, now), true, "7h late is stale")
  // A future row can't be claimed (`scheduled_at <= now()`), but must never be
  // called stale if it somehow is.
  assert.equal(isStale(hoursAgo(-2), 6, now), false, "a future send is not stale")
})

test("isStale: a zero grace makes any lateness stale, without failing the row", () => {
  const now = new Date("2026-08-03T09:30:00Z")
  assert.equal(isStale(new Date(now.getTime() - 1000), 0, now), true)
  assert.equal(isStale(now, 0, now), false)
})

// ── The day gate ──────────────────────────────────────────────────────────────

test("daysFor: follow-ups and opening emails read different settings", () => {
  const settings = { outreachDays: MON_THU, followUpDays: MON_FRI }
  assert.deepEqual(daysFor(false, settings), MON_THU)
  assert.deepEqual(daysFor(true, settings), MON_FRI)
})

test("isAllowedDay: judged in IST, not in the server's zone", () => {
  /*
   * 2026-08-09T19:00Z is Sunday evening in UTC but **Monday 00:30 IST**. A
   * Monday-only rule has to allow it, and a UTC-based check would refuse — which
   * would silently stall every send during the 18:30–24:00 UTC window.
   */
  const sundayEveningUtc = new Date("2026-08-09T19:00:00Z")
  assert.equal(isAllowedDay(sundayEveningUtc, [0]), true, "it is already Monday in IST")
  assert.equal(isAllowedDay(sundayEveningUtc, [6]), false, "it is no longer Sunday in IST")
})

test("isAllowedDay: covers each weekday exactly once over a week", () => {
  // Guards the 0=Monday…6=Sunday convention against Luxon's 1=Monday…7=Sunday.
  const monday = ist("2026-08-03T12:00")

  for (let offset = 0; offset < 7; offset += 1) {
    const day = monday.plus({ days: offset })
    const allowed = ALL_DAYS.filter((d) => isAllowedDay(day.toJSDate(), [d]))
    assert.deepEqual(allowed, [offset as Weekday], `${day.toFormat("ccc")} mapped wrong`)
  }
})

// ── The two errors that used to escape the tick ───────────────────────────────

test("an empty day list throws NoAllowedDayError rather than looping", () => {
  assert.throws(() => nextAllowedDay(ist("2026-08-03T09:30"), []), NoAllowedDayError)
  assert.throws(() => firstSendAt("09:30", [], ist("2026-08-03T08:00")), NoAllowedDayError)
  assert.throws(
    () => followUpSendAt(new Date(), 3, "09:30", [], ist("2026-08-03T08:00")),
    NoAllowedDayError
  )
  assert.throws(() => rescheduleStaleAt("09:30", [], ist("2026-08-03T08:00")), NoAllowedDayError)
})

test("a malformed send_time_ist throws InvalidSendTimeError, naming the value", () => {
  /*
   * Reachable from a hand-edited row: the column CHECK is the only thing enforcing
   * the shape, and "9:3" satisfies no validation the app applies. It must fail this
   * one lead loudly rather than compute a wrong instant.
   */
  for (const bad of ["9:3", "24:00", "", "09:60", "nonsense", "09:30:00"]) {
    assert.throws(
      () => firstSendAt(bad, ALL_DAYS, ist("2026-08-03T08:00")),
      InvalidSendTimeError,
      `"${bad}" should have been rejected`
    )
  }
})

test("a DST-free zone is assumed, and IST is one — no hour ever goes missing", () => {
  /*
   * Asia/Kolkata has no DST, which is what makes "09:30 every day" a safe promise.
   * Asserted rather than assumed: were the zone ever changed to one with DST, a
   * spring-forward would make `slotOn` return an invalid DateTime and `toDate`
   * throw — on one day a year, in production.
   */
  for (let day = 0; day < 366; day += 1) {
    const at = firstSendAt("02:30", ALL_DAYS, ist("2026-01-01T00:00").plus({ days: day }))
    assert.equal(
      DateTime.fromJSDate(at, { zone: IST_ZONE }).toFormat("HH:mm"),
      "02:30",
      `02:30 did not exist on day ${day}`
    )
  }
})

// ── desiredFollowUpTime — what the UI shows and the resync route writes ───────

/** A `sends` row in the domain shape `desiredFollowUpTime` takes. */
function sendRow(over: {
  stepPosition: number
  status: "pending" | "sent" | "sending" | "failed" | "cancelled" | "skipped"
  sentAt?: string
  scheduledAt?: string
}) {
  return {
    id: `send-${over.stepPosition}`,
    stepPosition: over.stepPosition,
    status: over.status,
    scheduledAt: over.scheduledAt ?? "2026-08-03T04:00:00.000Z",
    sentAt: over.sentAt ?? null,
    isFollowUp: over.stepPosition > 0,
  }
}

const STEPS = [
  { position: 0, kind: "email" as const, waitDays: undefined },
  { position: 1, kind: "delay" as const, waitDays: 3 },
  { position: 2, kind: "email" as const, waitDays: undefined },
]

test("desiredFollowUpTime: re-times a pending follow-up from its parent's real send", () => {
  const parent = sendRow({ stepPosition: 0, status: "sent", sentAt: "2026-08-03T04:00:00.000Z" })
  const pending = sendRow({ stepPosition: 2, status: "pending" })

  const at = desiredFollowUpTime({
    send: pending,
    sends: [parent, pending],
    steps: STEPS,
    sendTimeIST: "09:30",
    followUpDays: MON_FRI,
    now: ist("2026-08-03T10:00"),
  })

  // Parent went out Mon 09:30 IST; wait 3 → Thursday.
  assert.equal(asIST(at!), "Thu 2026-08-06 09:30")
})

test("desiredFollowUpTime: returns null for the things it must not touch", () => {
  const parent = sendRow({ stepPosition: 0, status: "sent", sentAt: "2026-08-03T04:00:00.000Z" })
  const base = {
    sends: [parent],
    steps: STEPS,
    sendTimeIST: "09:30",
    followUpDays: MON_FRI,
    now: ist("2026-08-03T10:00"),
  }

  // The opening email: its time came from the user's own launch.
  assert.equal(
    desiredFollowUpTime({ ...base, send: sendRow({ stepPosition: 0, status: "pending" }) }),
    null
  )
  // A row that isn't pending — sent is in someone's inbox, sending is in flight.
  for (const status of ["sent", "sending", "failed", "cancelled", "skipped"] as const) {
    assert.equal(
      desiredFollowUpTime({ ...base, send: sendRow({ stepPosition: 2, status }) }),
      null,
      `${status} must not be re-timed`
    )
  }
  // A row the sequence has moved out from under: position 2 is now a delay, so
  // re-timing it would schedule the wrong email.
  assert.equal(
    desiredFollowUpTime({
      ...base,
      send: sendRow({ stepPosition: 2, status: "pending" }),
      steps: [STEPS[0]!, STEPS[1]!, { position: 2, kind: "delay", waitDays: 1 }],
    }),
    null
  )
})

test("desiredFollowUpTime: agrees with what enqueueNextStep would have written", () => {
  /*
   * The rail shows this, the resync route writes it, and `enqueueNextStep` computes
   * the queued row from `followUpSendAt` — three call sites that must not disagree,
   * because the user reads one and the scheduler fires another.
   */
  const sentAt = "2026-08-03T04:00:00.000Z"
  const parent = sendRow({ stepPosition: 0, status: "sent", sentAt })
  const pending = sendRow({ stepPosition: 2, status: "pending" })
  const now = ist("2026-08-03T10:00")

  const shown = desiredFollowUpTime({
    send: pending,
    sends: [parent, pending],
    steps: STEPS,
    sendTimeIST: "09:30",
    followUpDays: MON_FRI,
    now,
  })

  const queued = followUpSendAt(new Date(sentAt), 3, "09:30", MON_FRI, now)

  assert.equal(shown!.toISOString(), queued.toISOString())
})
