import test from "node:test"
import assert from "node:assert/strict"
import { DateTime } from "luxon"
import {
  firstSendAt,
  followUpSendAt,
  projectSequenceSchedule,
} from "../../shared/schedule.ts"
import type { SequenceSend, SequenceStep, StepTiming, Weekday } from "../../shared/types.ts"

/**
 * The compose rail's dates against what the send loop will actually do.
 *
 * `projectSequenceSchedule` draws the sidebar; `firstSendAt` / `followUpSendAt` decide
 * when the tick fires. They are the same functions underneath — that is why
 * `shared/schedule.ts` exists — but "same functions" is only true if the projection
 * calls them with the same arguments the scheduler will, and that is what can drift:
 * the wrong day list for a class, a wait counted from the wrong anchor, a projection
 * chained from a step that will never send.
 *
 * A wrong date here is not cosmetic. It is the screen the user reads before clicking
 * Launch — the one place the promise "your prospect gets this Thursday morning" is
 * made — so a rail that disagrees with the queue is the tool lying about the only
 * thing it is for.
 */

const MON_THU: Weekday[] = [0, 1, 2, 3]
const MON_FRI: Weekday[] = [0, 1, 2, 3, 4]

function ist(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: "Asia/Kolkata" })
}

/** opening → wait `waits[0]` → follow-up → wait `waits[1]` → follow-up … */
function sequence(...waits: number[]): SequenceStep[] {
  const steps: SequenceStep[] = [
    { id: "s0", kind: "email", name: "Opening", subject: "Hello", bodyHtml: "<p>hi</p>" },
  ]

  for (const [index, wait] of waits.entries()) {
    steps.push({ id: `w${index}`, kind: "delay", name: "Wait", waitDays: wait })
    steps.push({
      id: `s${index + 1}`,
      kind: "email",
      name: `Follow-up ${index + 1}`,
      subject: "",
      bodyHtml: "<p>bump</p>",
    })
  }

  return steps
}

function at(timing: StepTiming | undefined): string {
  assert.ok(timing, "expected a timing for that step")
  assert.ok("at" in timing, `expected a dated timing, got ${timing.kind}`)
  return timing.at
}

test("an unlaunched sequence projects exactly what the scheduler will compute", () => {
  /*
   * Nothing queued yet, so every step is a projection — and every one of them must
   * equal the arithmetic the tick will do when it gets there. Asserted by recomputing
   * the chain independently rather than against hard-coded dates: a hard-coded
   * expectation tests that the rail matches *me*, not that it matches the queue.
   */
  const now = ist("2026-08-03T08:00")
  const steps = sequence(3, 4)

  const { timings } = projectSequenceSchedule({
    steps,
    sends: [],
    sendTimeIST: "09:30",
    outreachDays: MON_THU,
    followUpDays: MON_FRI,
    now,
  })

  const opening = firstSendAt("09:30", MON_THU, now)
  const first = followUpSendAt(opening, 3, "09:30", MON_FRI, now)
  const second = followUpSendAt(first, 4, "09:30", MON_FRI, now)

  assert.equal(at(timings.get("s0")), opening.toISOString())
  assert.equal(at(timings.get("s1")), first.toISOString())
  assert.equal(at(timings.get("s2")), second.toISOString())

  // And all three are labelled as guesses, because none has a row behind it.
  for (const id of ["s0", "s1", "s2"]) {
    assert.equal(timings.get(id)!.kind, "projected", `${id} must be hedged, not stated`)
  }
})

test("the projection uses the follow-up day list for follow-ups, the outreach one for the opener", () => {
  /*
   * The classes have separate day lists, and mixing them up is invisible in the
   * common case where both are the same. Made visible here by making them disjoint:
   * outreach on Monday only, follow-ups on Friday only. Any step landing on the wrong
   * weekday means the rail is projecting with the other class's rule.
   */
  const now = ist("2026-08-03T08:00") // Monday
  const { timings } = projectSequenceSchedule({
    steps: sequence(1, 1),
    sends: [],
    sendTimeIST: "09:30",
    outreachDays: [0], // Monday
    followUpDays: [4], // Friday
    now,
  })

  const weekdayOf = (id: string): number =>
    DateTime.fromISO(at(timings.get(id)!), { zone: "utc" }).setZone("Asia/Kolkata").weekday

  assert.equal(weekdayOf("s0"), 1, "the opening email must land on Monday")
  assert.equal(weekdayOf("s1"), 5, "a follow-up must land on Friday")
  assert.equal(weekdayOf("s2"), 5)
})

test("a queued row is read from the database, never recomputed", () => {
  /*
   * The authority rule. A pending row's `scheduled_at` is what `claim_due_sends` will
   * match on, so the rail has to show *that*, even when the arithmetic would now give
   * a different answer — otherwise the sidebar quietly disagrees with the queue and
   * the user is told a time no code will act on.
   */
  const now = ist("2026-08-03T08:00")
  const queuedAt = "2026-08-05T04:00:00.000Z" // deliberately not what firstSendAt gives

  const sends: SequenceSend[] = [
    { id: "send0", stepPosition: 0, status: "pending", scheduledAt: queuedAt },
  ]

  const { timings } = projectSequenceSchedule({
    steps: sequence(3),
    sends,
    sendTimeIST: "09:30",
    outreachDays: MON_THU,
    followUpDays: MON_FRI,
    now,
  })

  const opening = timings.get("s0")!
  assert.equal(opening.kind, "scheduled", "a real row is stated, not projected")
  assert.equal(at(opening), queuedAt, "the row's own time, not a recomputed one")

  // And the follow-up chains from the queued time rather than from the arithmetic.
  assert.equal(
    at(timings.get("s1")),
    followUpSendAt(new Date(queuedAt), 3, "09:30", MON_FRI, now).toISOString()
  )
})

test("a delivered step anchors the chain on when it really went out", () => {
  /*
   * The reason follow-ups are queued lazily: "wait 3 days" means three days after the
   * recipient actually received the previous email, not three days after the time it
   * was once planned for. An email that went out two days late must push its
   * follow-up two days too — matching `enqueueNextStep`, which passes `new Date()`.
   */
  const now = ist("2026-08-06T12:00")
  const plannedAt = "2026-08-03T04:00:00.000Z"
  const actuallySentAt = "2026-08-05T04:05:00.000Z" // two days late

  const { timings } = projectSequenceSchedule({
    steps: sequence(3),
    sends: [
      {
        id: "send0",
        stepPosition: 0,
        status: "sent",
        scheduledAt: plannedAt,
        sentAt: actuallySentAt,
      },
    ],
    sendTimeIST: "09:30",
    outreachDays: MON_THU,
    followUpDays: MON_FRI,
    now,
  })

  assert.equal(at(timings.get("s0")), actuallySentAt, "history is what happened")
  assert.equal(
    at(timings.get("s1")),
    followUpSendAt(new Date(actuallySentAt), 3, "09:30", MON_FRI, now).toISOString(),
    "the wait runs from the real send, as enqueueNextStep computes it"
  )
})

test("a reply stops the rail at the same place it stops the queue", () => {
  const now = ist("2026-08-06T12:00")
  const { timings, replyAfterStepId } = projectSequenceSchedule({
    steps: sequence(3, 4),
    sends: [
      {
        id: "send0",
        stepPosition: 0,
        status: "sent",
        scheduledAt: "2026-08-03T04:00:00.000Z",
        sentAt: "2026-08-03T04:00:00.000Z",
      },
    ],
    sendTimeIST: "09:30",
    outreachDays: MON_THU,
    followUpDays: MON_FRI,
    repliedAt: "2026-08-04T09:00:00.000Z",
    now,
  })

  assert.equal(replyAfterStepId, "s0", "the marker goes under the email they answered")

  for (const id of ["s1", "s2"]) {
    const timing = timings.get(id)!
    assert.equal(timing.kind, "stopped", `${id} must not show a future date after a reply`)
    assert.equal(timing.kind === "stopped" && timing.cause, "replied")
  }
})

test("a failed step blocks everything behind it rather than showing a date", () => {
  /*
   * `enqueueNextStep` runs only after a *successful* send, so nothing behind a failed
   * step will ever be queued. A confident date there would be the rail promising an
   * email the loop has no path to sending.
   */
  const now = ist("2026-08-06T12:00")
  const { timings } = projectSequenceSchedule({
    steps: sequence(3, 4),
    sends: [
      {
        id: "send0",
        stepPosition: 0,
        status: "failed",
        scheduledAt: "2026-08-03T04:00:00.000Z",
      },
    ],
    sendTimeIST: "09:30",
    outreachDays: MON_THU,
    followUpDays: MON_FRI,
    now,
  })

  assert.equal(timings.get("s0")!.kind, "blocked")
  assert.equal(timings.get("s1")!.kind, "blocked")
  assert.equal(timings.get("s2")!.kind, "blocked")
})

test("no projected step is ever in the past, at any time of day", () => {
  /*
   * The rail is read before clicking Launch, so a date already gone is the one that
   * actually misleads: it reads as "goes out today" for something the tick will move.
   * Swept across the whole clock because the failure is time-of-day dependent — it
   * only appears when `now` is past the send slot.
   */
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 29, 30, 31, 59]) {
      const now = ist(
        `2026-08-03T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      )

      const { timings } = projectSequenceSchedule({
        steps: sequence(0, 1, 3),
        sends: [],
        sendTimeIST: "09:30",
        outreachDays: MON_THU,
        followUpDays: MON_FRI,
        now,
      })

      let previous = now.toMillis()

      for (const id of ["s0", "s1", "s2", "s3"]) {
        const millis = Date.parse(at(timings.get(id)!))

        assert.ok(millis > now.toMillis(), `${id} at ${now.toISO()} is in the past`)
        // And strictly increasing: two emails in a sequence must never share a slot,
        // even when a wait is 0 days.
        assert.ok(millis > previous, `${id} at ${now.toISO()} does not follow the step before`)
        previous = millis
      }
    }
  }
})

test("an unscheduleable lead shows one blocked card rather than throwing mid-render", () => {
  // This runs during render, so an empty day list or a hand-edited `send_time_ist`
  // has to degrade to a message on a card. Throwing would blank the whole editor.
  const now = ist("2026-08-03T08:00")

  for (const bad of [
    { outreachDays: [] as Weekday[], sendTimeIST: "09:30" },
    { outreachDays: MON_THU, sendTimeIST: "9:3" },
    { outreachDays: MON_THU, sendTimeIST: "24:00" },
  ]) {
    const { timings } = projectSequenceSchedule({
      steps: sequence(3),
      sends: [],
      sendTimeIST: bad.sendTimeIST,
      outreachDays: bad.outreachDays,
      followUpDays: MON_FRI,
      now,
    })

    assert.equal(
      timings.get("s0")!.kind,
      "blocked",
      `${JSON.stringify(bad)} should block, not throw`
    )
    assert.equal(timings.get("s1")!.kind, "blocked", "and the rest of the chain with it")
  }
})

test("the browser's time zone cannot change a projected date", () => {
  /*
   * The rail runs in the user's browser and the tick runs on EC2, from the same
   * function — so the answer has to depend only on IST and the instant, never on the
   * host zone. A `setHours` anywhere in the chain would break exactly this.
   */
  const instant = "2026-08-03T02:30:00.000Z"
  const answers = new Set<string>()

  for (const zone of ["utc", "Asia/Kolkata", "America/New_York", "Australia/Sydney"]) {
    const { timings } = projectSequenceSchedule({
      steps: sequence(3),
      sends: [],
      sendTimeIST: "09:30",
      outreachDays: MON_THU,
      followUpDays: MON_FRI,
      now: DateTime.fromISO(instant, { zone }),
    })

    answers.add(`${at(timings.get("s0")!)}|${at(timings.get("s1")!)}`)
  }

  assert.equal(answers.size, 1, `the host zone changed the answer: ${[...answers].join(" vs ")}`)
})
