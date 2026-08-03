import { DateTime } from "luxon"
import { nextEmailAfter } from "./sequence.ts"
import { IST_ZONE, parseISTTime, toWeekday } from "./time.ts"
import type { SequenceSend, SequenceStep, StepTiming, Weekday } from "./types.ts"

/**
 * When a send is due — all the IST/weekday/next-slot arithmetic, with no database
 * and no Gmail in sight.
 *
 * **Shared, not server-only, on purpose.** The scheduler decides when an email
 * actually goes out, and the compose sidebar shows the user when it will; those
 * two answers have to agree, so they are the same functions rather than the same
 * rule written twice. `server/src/scheduler/schedule.ts` re-exports this and adds
 * only the send loop's pacing (jitter, sleep), which has no business in a
 * projection.
 *
 * Two rules the whole file exists to enforce:
 *  1. A send goes out at the lead's own IST time, on a day the settings allow.
 *  2. Nothing is ever scheduled in the past, so a launch always produces a real
 *     future slot rather than something the next tick fires immediately.
 *
 * Run the server with `TZ=UTC`. Every instant here is either explicitly IST or
 * explicitly UTC; the host's local zone is never consulted — which is what lets
 * the browser and the server compute the same answer from different time zones.
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
 * The next `sendTimeIst` slot that is still ahead of `now` — today's if it hasn't
 * passed, otherwise tomorrow's.
 *
 * Shared by `firstSendAt` and `rescheduleStaleAt` because "when is the next real
 * chance to send this" is one question, and the two answering it differently is
 * precisely the bug this replaced: a row that missed its slot was pushed a day past
 * the first slot it could actually have used.
 */
function nextFutureSlot(sendTimeIst: string, reference: DateTime): DateTime {
  const slot = slotOn(reference, sendTimeIst)

  // Strictly in the future: a slot exactly equal to now would be claimable by
  // the tick already running, which makes the launch response a lie.
  return slot <= reference ? slot.plus({ days: 1 }) : slot
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

  return toDate(nextAllowedDay(nextFutureSlot(sendTimeIst, reference), outreachDays))
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
  const parentAt = DateTime.fromJSDate(sentAt, { zone: IST_ZONE })
  const base = parentAt.plus({ days: Math.max(waitDays, 0) })

  let slot = slotOn(base, sendTimeIst)

  /*
   * The follow-up has to clear two separate floors, so the guard is against the
   * later of them.
   *
   * `now` is the obvious one: a slot already past would be claimed on the very next
   * tick, turning "wait 0 days" into two emails inside the same minute.
   *
   * `sentAt` is the one that was missing, and it only bites when the parent is in the
   * **future** — which is exactly the case the compose rail is in. It chains
   * projections forward, so it asks for a follow-up to an email that hasn't gone out
   * yet: with a 0-day wait, `slot` came back equal to the parent's own slot, `now` was
   * hours earlier so the old check didn't fire, and the rail drew both emails at the
   * same minute on the same day. The scheduler never agreed — `enqueueNextStep` passes
   * the real send time as both `sentAt` and `now`, so its slot was always in the past
   * and got pushed to the next day — which is the worse half of the bug: the sidebar
   * confidently showed a schedule the queue would not honour, on the screen the user
   * reads before launching.
   *
   * Taking the maximum leaves the scheduler's own answers untouched (there `sentAt` is
   * `now`, and for a late send `now` is later still) and fixes the projection.
   */
  const floor = DateTime.max(now.setZone(IST_ZONE), parentAt)

  if (slot <= floor) slot = slotOn(floor.plus({ days: 1 }), sendTimeIst)

  return toDate(nextAllowedDay(slot, followUpDays))
}

/**
 * A step as this file needs it: ordered, and knowing how long the wait before it
 * is. Structural — `PositionedStep` on the server and an index into the step array
 * in the browser both satisfy it, which is what lets one rule serve both.
 */
export interface OrderedStep {
  position: number
  kind: SequenceStep["kind"]
  waitDays?: number | undefined
}

/**
 * When a **pending** send should go out given the sequence as it stands now, or
 * `null` when there is nothing to recompute.
 *
 * The one definition of that rule, deliberately in `shared/` and called from both
 * sides: the resync route moves the row, and the compose rail shows the new time
 * the moment the user changes a wait. Two implementations of this would mean the
 * date on screen and the date in the queue could disagree — which is the exact bug
 * the resync route was added to fix, so reproducing it one level up would be
 * absurd.
 *
 * `null` in three cases, each of which means "don't touch this":
 *  - **The opening email.** Its time comes from `firstSendAt` at launch and no
 *    wait bears on it, so recomputing would shove the user's own launch time
 *    around.
 *  - **A row that isn't pending.** Sent, sending, cancelled — none can be re-timed.
 *  - **A row the sequence no longer agrees with.** If a step was added or deleted
 *    the positions have shifted underneath it, and re-timing a row that points at
 *    the wrong step would just schedule the wrong email.
 */
export function desiredFollowUpTime(input: {
  send: SequenceSend
  /** Every `sends` row for the lead. Order doesn't matter. */
  sends: readonly SequenceSend[]
  steps: readonly OrderedStep[]
  sendTimeIST: string
  followUpDays: readonly Weekday[]
  now?: DateTime | undefined
}): Date | null {
  const { send, sends, steps, sendTimeIST, followUpDays } = input
  const now = input.now ?? DateTime.utc()

  if (send.status !== "pending") return null

  /*
   * The email this one waits on: the latest *sent* row above it. The wait counts
   * from when that message really went out — the rule `enqueueNextStep` applies —
   * so no parent means nothing has been sent yet and this is the opening email.
   */
  const parent = sends
    .filter((row) => row.status === "sent" && row.stepPosition < send.stepPosition)
    .sort((a, b) => b.stepPosition - a.stepPosition)[0]

  if (!parent?.sentAt) return null

  const next = nextEmailAfter(steps, parent.stepPosition)
  if (!next || next.step.position !== send.stepPosition) return null

  return followUpSendAt(
    new Date(parent.sentAt),
    next.waitDays,
    sendTimeIST,
    followUpDays,
    now
  )
}

/**
 * Where to move a send that is too old to deliver now, or that has landed on a day
 * its settings don't allow.
 *
 * The next allowed day at the lead's usual time, never "right now": a laptop closed
 * over the weekend must not deliver Friday's 09:30 email at 02:00 on Monday, which
 * reads as a bot to both the recipient and Gmail.
 *
 * **The next slot, though — not tomorrow's.** This used to add a day unconditionally,
 * which quietly skipped the first slot the send could actually have used. The trigger
 * was the ordinary case rather than an exotic one: a row left over from a capped day
 * is claimed by the first tick after IST midnight, is ~14h late so the grace window
 * fails it, and got pushed to *the day after* the morning it was sitting there
 * waiting for. A 20-follow-up backlog against a cap of 10 therefore drained 10, 0,
 * 10, 0 — every second day silently dead, and every recipient in the tail a day
 * further behind their own send time than the settings implied. Now the same
 * before/after-the-slot test `firstSendAt` uses (`nextFutureSlot`), so today at 00:01
 * still gets today at 09:30.
 */
export function rescheduleStaleAt(
  sendTimeIst: string,
  allowedDays: readonly Weekday[],
  now: DateTime = DateTime.utc()
): Date {
  const reference = now.setZone(IST_ZONE)

  return toDate(nextAllowedDay(nextFutureSlot(sendTimeIst, reference), allowedDays))
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

/** What the compose rail needs to render a sequence's timeline. */
export interface SequenceSchedule {
  /** When each **email** step is due, keyed by step id. Waits get no entry. */
  timings: Map<string, StepTiming>
  /**
   * The step after which the recipient replied, or `null` if they haven't.
   *
   * A step id rather than a boolean or a position, because the reply is rendered
   * *between* two cards and the rail iterates step ids. Null both when there is no
   * reply and when one arrived before anything was sent — there is no card to hang
   * the marker under in that case.
   */
  replyAfterStepId: string | null
}

/**
 * What the compose sidebar shows against each email in a sequence: what already
 * went out and when, and when the rest are due.
 *
 * ## Facts and estimates are kept apart
 *
 * Follow-ups are queued **lazily** — `sends` gains a row for step N+1 only after
 * step N has actually gone out (see `enqueueNextStep`). So at any moment at most
 * one unsent step has a real `scheduled_at`, and everything past it has no row at
 * all. Those later steps are therefore *projected* by chaining `followUpSendAt`
 * from the step before, and they are labelled `projected` rather than
 * `scheduled` so the UI can hedge them. A projection can move for reasons this
 * function cannot see: the previous email may go out late, the weekday settings
 * may change, or a reply may end the sequence.
 *
 * Anything with a row is read from the row and never recomputed — the database is
 * the authority on a send that already exists, and re-deriving it here would let
 * the sidebar disagree with what the scheduler is actually going to do.
 *
 * ## Why the chain breaks rather than guesses
 *
 * A failed or cancelled step produces no follow-up: `enqueueNextStep` runs only
 * after a *successful* send. Showing a confident future time for a step sitting
 * behind a permanent failure would be a lie, so those come back as `blocked`.
 * Likewise, once a lead has replied the sequence is over and the remaining steps
 * are `stopped`, not merely late.
 *
 * ## Where the reply goes
 *
 * A reply is not a property of any one step — it arrives *between* two of them —
 * so it comes back as `replyAfterStepId` rather than as a timing. That is the last
 * email the recipient had actually received when they wrote back, which is the
 * only honest place to draw the line: the steps above it are what earned the
 * reply, and everything below it is what the reply called off.
 *
 * Timings are keyed by step id (not position) because that is what the component
 * renders from. `delay` steps get no entry — they are the wait, not a message.
 */
export function projectSequenceSchedule(input: {
  /** Position-ordered, exactly as stored: index N is `position` N. */
  steps: readonly SequenceStep[]
  /** Every `sends` row for this lead. Order doesn't matter. */
  sends: readonly SequenceSend[]
  sendTimeIST: string
  outreachDays: readonly Weekday[]
  followUpDays: readonly Weekday[]
  /** Set once a reply is detected — the sequence stops there. */
  repliedAt?: string | undefined
  now?: DateTime | undefined
}): SequenceSchedule {
  const { steps, sends, sendTimeIST, outreachDays, followUpDays, repliedAt } = input
  const now = input.now ?? DateTime.utc()

  const timings = new Map<string, StepTiming>()
  const byPosition = new Map(sends.map((send) => [send.stepPosition, send]))

  /*
   * Positions from the array index, which is what `steps` being "position-ordered,
   * exactly as stored" means — the domain `SequenceStep` has no position of its own
   * (see `PositionedStep` on the server). Built once here rather than per row, and
   * it is the same numbering `sends.step_position` is written from.
   */
  const orderedSteps: OrderedStep[] = steps.map((step, position) => ({
    position,
    kind: step.kind,
    waitDays: step.waitDays,
  }))

  /**
   * The last email that had gone out before the reply arrived — where the rail
   * draws its "replied" marker.
   *
   * Tracked as the walk proceeds rather than picked out afterwards, because the
   * answer is positional: it is the deepest `sent` step above the first stopped
   * one, and the loop already visits them in that order.
   */
  let replyAfterStepId: string | null = null

  /** Days of waiting seen since the previous email step. */
  let waitDays = 0
  /**
   * When the previous email goes out — the base every projection chains from.
   * `null` until an email has a time, which is what identifies the opening email
   * (it uses `firstSendAt` and the outreach days, not the follow-up days).
   */
  let previousAt: Date | null = null
  /** Why nothing further can be scheduled, once that becomes true. */
  let blocked: string | null = null

  for (const [position, step] of steps.entries()) {
    if (step.kind === "delay") {
      waitDays += step.waitDays ?? 0
      continue
    }

    const carriedWaitDays = waitDays
    waitDays = 0

    const send = byPosition.get(position)

    if (send) {
      const timing = timingFromSend({
        send,
        sends,
        steps: orderedSteps,
        sendTimeIST,
        followUpDays,
        repliedAt,
        now,
      })
      timings.set(step.id, timing)

      /*
       * The reply marker goes after the last email that actually went out. Any
       * `sent` step is above the reply by construction — a reply cancels every
       * pending row — so the last one seen is the one the recipient was answering.
       *
       * Gated on `repliedAt`, which is the whole condition: without it this tracked
       * the last sent step on *every* lead and the rail claimed a reply on one that
       * had merely had an email delivered.
       */
      if (repliedAt && timing.kind === "sent") replyAfterStepId = step.id

      // Only a real instant can anchor the next projection. A failed or cancelled
      // row anchors nothing and stops the chain instead. `sending` neither
      // anchors nor blocks: it is about to become one of the two.
      if (timing.kind === "sent" || timing.kind === "scheduled") {
        previousAt = new Date(timing.at)
      } else if (timing.kind === "stopped" || timing.kind === "blocked") {
        blocked = timing.reason
      }
      continue
    }

    if (repliedAt) {
      timings.set(step.id, {
        kind: "stopped",
        cause: "replied",
        reason: "the recipient replied",
      })
      continue
    }

    if (blocked) {
      timings.set(step.id, { kind: "blocked", reason: blocked })
      continue
    }

    /*
     * `InvalidSendTimeError` / `NoAllowedDayError` are both reachable from real
     * data — a hand-edited `send_time_ist`, or every weekday switched off in
     * Settings. Caught rather than thrown because this runs during render: an
     * unscheduleable lead must show "no time" on one card, not blank the editor.
     */
    try {
      const at =
        previousAt === null
          ? firstSendAt(sendTimeIST, outreachDays, now)
          : followUpSendAt(previousAt, carriedWaitDays, sendTimeIST, followUpDays, now)

      timings.set(step.id, { kind: "projected", at: at.toISOString() })
      previousAt = at
    } catch (error) {
      timings.set(step.id, {
        kind: "blocked",
        reason: error instanceof Error ? error.message : "the send time can't be worked out",
      })
      blocked = "an earlier step has no valid send time"
    }
  }

  return { timings, replyAfterStepId }
}

/**
 * One `sends` row → what to show.
 *
 * The row is authoritative for everything that has **happened** — sent, sending,
 * failed, cancelled — and nothing about those is recomputed.
 *
 * A `pending` row is the one exception, and it is the point of this signature. Its
 * `scheduled_at` is a snapshot taken when the previous email went out, so editing a
 * wait afterwards leaves it stale until the resync route moves it. Showing the row
 * verbatim is what made a wait change look like it hadn't registered; showing
 * `desiredFollowUpTime`'s answer instead means the date under the card is right on
 * the same frame as the number in the wait card, and the server write behind it
 * only has to agree — which it does, because it is the same function.
 *
 * Still `scheduled` rather than `projected`: the commitment is real either way. It
 * is a queued row whose time is about to be corrected, not a guess about a row that
 * doesn't exist.
 */
function timingFromSend(input: {
  send: SequenceSend
  sends: readonly SequenceSend[]
  steps: readonly OrderedStep[]
  sendTimeIST: string
  followUpDays: readonly Weekday[]
  repliedAt?: string | undefined
  now: DateTime
}): StepTiming {
  const { send, repliedAt } = input

  switch (send.status) {
    case "sent":
      // `sent_at` is written in the same update as the status, so the fallback is
      // for a row mid-write rather than a real state.
      return { kind: "sent", at: send.sentAt ?? send.scheduledAt }
    case "sending":
      return { kind: "sending" }
    case "pending": {
      /*
       * A reply outranks the queue. The scheduler cancels these rows on the next
       * reply check, but until that runs the row still says `pending` — and
       * announcing a send date for an email that will never go out is the one
       * mistake this whole hedging scheme exists to avoid.
       */
      if (repliedAt) {
        return { kind: "stopped", cause: "replied", reason: "the recipient replied" }
      }

      /*
       * `null` covers the opening email and a row the sequence has moved out from
       * under — see `desiredFollowUpTime`. Both mean "the row's own time is the
       * best answer there is".
       */
      const desired = desiredFollowUpTime(input)
      return { kind: "scheduled", at: desired?.toISOString() ?? send.scheduledAt }
    }
    case "failed":
      return { kind: "blocked", reason: "the previous email couldn't be sent" }
    /*
     * Reached only by rows `sendQueue.cancel` marked individually — a reply landing
     * between the claim and the send. A *pending* row that is cancelled, whether by
     * the user or by reply detection, is deleted instead of marked, because the
     * `(lead_id, step_position)` unique index would otherwise let a dead row block
     * that step from ever being queued again. So this case is rarer than it looks,
     * and a cancelled step usually shows as `projected` again rather than stopped.
     */
    case "cancelled":
      return {
        kind: "stopped",
        // A cancelled row on a lead that replied was cancelled *by* the reply —
        // that is how `markRepliedAndCancel` ends a sequence. Naming the reply is
        // more use than "this email was cancelled", which reads as the user's doing.
        ...(repliedAt
          ? { cause: "replied" as const, reason: "the recipient replied" }
          : { cause: "cancelled" as const, reason: "this email was cancelled" }),
      }
    case "skipped":
      return { kind: "stopped", cause: "skipped", reason: "this email was skipped" }
  }
}
