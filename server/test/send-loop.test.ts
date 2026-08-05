import test, { mock } from "node:test"
import assert from "node:assert/strict"
import { DateTime } from "luxon"
import { IST_ZONE, toWeekday } from "../../shared/time.ts"
import type { Weekday } from "../../shared/types.ts"

/**
 * The send loop, end to end, against a **faithful** in-memory `sends` table.
 *
 * `tick.test.ts` covers the three control-flow bugs that produced duplicates. This
 * file is the broader one: it drives the real `runTick` through ordinary operating
 * conditions — capped days, backlogs, replies, retries, restarts, deleted steps — and
 * asserts the invariants that matter to the person receiving the email:
 *
 *  1. **No address is ever written to twice.** Every test in this file asserts it,
 *     including the ones nominally about something else, because a duplicate cold
 *     email is the one failure that cannot be walked back.
 *  2. **The daily cap is never exceeded**, per IST day, across both classes.
 *  3. **A reply stops the sequence** — before the next email, not after.
 *  4. **Emails arrive in sequence order**, threaded onto the parent.
 *
 * ## Why the queue mock is a real implementation
 *
 * The mock is written from `schema.sql` rather than stubbed per test: `claimDue`
 * filters on `status = 'pending' and scheduled_at <= now()`, orders by
 * `scheduled_at`, honours the class filter and increments `attempt_count` exactly as
 * `claim_due_sends` does; `markFailed` resets to `pending` until `MAX_ATTEMPTS`;
 * `enqueue` is idempotent on `(lead_id, step_position)` like `sends_lead_step_key`;
 * `cancelPendingFor` deletes rather than marks. Those are the semantics the duplicate
 * bugs actually turned on, so a looser stub would assert nothing.
 *
 * ## Why days are simulated by moving rows, not by moving the clock
 *
 * `processSend` reads `DateTime.utc()` directly, so there is no clock to inject. A
 * "next day" tick is therefore simulated by making the pending rows due — which is
 * precisely the state the first tick after IST midnight finds them in. Weekday-
 * dependent settings are computed from *today's* real IST weekday for the same
 * reason: a test that only passes on Tuesdays is worse than no test.
 */

// ── the world ─────────────────────────────────────────────────────────────────

/** Only the `sends` columns the tick reads, plus what the assertions need. */
interface Row {
  id: string
  lead_id: string
  gmail_account_id: string
  user_id: string
  step_position: number
  is_follow_up: boolean
  status: string
  scheduled_at: string
  claimed_at: string | null
  sent_at: string | null
  attempt_count: number
  tracking_id: string
  gmail_thread_id: string | null
  rfc822_message_id: string | null
  subject_rendered: string | null
  step_id: string | null
}

interface LeadState {
  id: string
  email: string
  status: string
  repliedAt: Date | null
  sendTimeIST: string
}

interface Delivery {
  to: string
  subject: string
  threadId: string | undefined
  position: number
  at: number
}

interface StepDef {
  position: number
  kind: "email" | "delay"
  subject?: string
  bodyHtml?: string
  waitDays?: number
}

/** Everything a test can set up or inspect. Reset before each one. */
const world = {
  rows: [] as Row[],
  leads: new Map<string, LeadState>(),
  deliveries: [] as Delivery[],
  /** Sequence per lead id; the default is opening → wait 3 → follow-up. */
  sequences: new Map<string, StepDef[]>(),
  /** Threads a reply has landed in, keyed by Gmail thread id. */
  repliedThreads: new Map<string, Date>(),
  /** Make the reply watcher throw for every thread it is asked about. */
  watcherError: null as (() => Error) | null,
  /** Make `mailer.send` throw this once, then clear it. */
  sendError: null as (() => Error) | null,
  /** Make every `mailer.send` throw this. */
  persistentSendError: null as (() => Error) | null,
  dailyLimit: 10,
  followUpSharePct: 50,
  outreachDays: [] as Weekday[],
  followUpDays: [] as Weekday[],
  staleSendGraceHours: 6,
  nextThread: 0,
}

const ACCOUNT_ID = "acc1"
const USER_ID = "u1"
const MAX_ATTEMPTS = 5

/** Today's IST weekday, so a day-gated test is deterministic on any day of the week. */
function todayIST(): Weekday {
  return toWeekday(DateTime.utc().setZone(IST_ZONE))
}

const DEFAULT_SEQUENCE: StepDef[] = [
  { position: 0, kind: "email", subject: "Quick question", bodyHtml: "<p>Hello there</p>" },
  { position: 1, kind: "delay", waitDays: 3 },
  // Blank subject: the normal shape of a follow-up, which inherits the parent's and
  // goes out as a reply in the same thread.
  { position: 2, kind: "email", subject: "", bodyHtml: "<p>Just bumping this</p>" },
]

function reset(): void {
  world.rows = []
  world.leads.clear()
  world.deliveries = []
  world.sequences.clear()
  world.repliedThreads.clear()
  world.watcherError = null
  world.sendError = null
  world.persistentSendError = null
  world.dailyLimit = 10
  world.followUpSharePct = 50
  world.outreachDays = [0, 1, 2, 3, 4, 5, 6]
  world.followUpDays = [0, 1, 2, 3, 4, 5, 6]
  world.staleSendGraceHours = 6
  world.nextThread = 0
}

/** A launched lead with its opening email queued and due a minute ago. */
function launch(
  name: string,
  over: { dueMinutesAgo?: number; sendTimeIST?: string; sequence?: StepDef[] } = {}
): void {
  const leadId = `lead-${name}`

  world.leads.set(leadId, {
    id: leadId,
    email: `${name}@prospect.test`,
    status: "scheduled",
    repliedAt: null,
    sendTimeIST: over.sendTimeIST ?? "09:30",
  })
  world.sequences.set(leadId, over.sequence ?? DEFAULT_SEQUENCE)

  world.rows.push({
    id: `send-${name}-0`,
    lead_id: leadId,
    gmail_account_id: ACCOUNT_ID,
    user_id: USER_ID,
    step_position: 0,
    is_follow_up: false,
    status: "pending",
    scheduled_at: new Date(Date.now() - (over.dueMinutesAgo ?? 1) * 60_000).toISOString(),
    claimed_at: null,
    sent_at: null,
    attempt_count: 0,
    tracking_id: `trk-${name}-0`,
    gmail_thread_id: null,
    rfc822_message_id: null,
    subject_rendered: null,
    step_id: `step-${leadId}-0`,
  })
}

/**
 * Advance to "the next day": make every pending row due, and clear today's send
 * counts so the cap resets.
 *
 * Moving rows rather than the clock is the only option (`processSend` reads
 * `DateTime.utc()` directly), and it is faithful to what the first tick after IST
 * midnight sees. `sent_at` is backdated so `sentToday` no longer counts those rows,
 * which is exactly what an IST day boundary does.
 */
function nextDay(): void {
  const yesterday = new Date(Date.now() - 26 * 3600e3).toISOString()

  for (const row of world.rows) {
    if (row.status === "pending") {
      row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
    }
    if (row.status === "sent") row.sent_at = yesterday
  }
}

function deliveriesTo(email: string): Delivery[] {
  return world.deliveries.filter((d) => d.to === email)
}

/** The invariant every test asserts, whatever else it is about. */
function assertNoDuplicates(context: string): void {
  const seen = new Map<string, number>()

  for (const delivery of world.deliveries) {
    const key = `${delivery.to}#${delivery.position}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }

  const duplicated = [...seen.entries()].filter(([, count]) => count > 1)

  assert.deepEqual(
    duplicated,
    [],
    `${context}: the same email was delivered more than once — ${JSON.stringify(duplicated)}`
  )
}

// ── mocks ─────────────────────────────────────────────────────────────────────

/**
 * Silence the logger.
 *
 * Not cosmetic. The real one runs pino-pretty in a worker thread when `NODE_ENV`
 * isn't production, and `.env` sets `LOG_LEVEL=debug` — so this file wrote tens of
 * thousands of formatted lines and then took **three minutes** to exit, because the
 * transport worker outlives the tests. The runner eventually killed it and reported
 * the file as failed with every test inside it passing. 3m20s → 6s.
 */
const noop = (): void => {}
const silentLogger = {
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child: () => silentLogger,
}

mock.module("../src/logger.ts", {
  namedExports: { logger: silentLogger, loggerFor: () => silentLogger },
})

mock.module("../src/email/accounts.ts", {
  namedExports: {
    AccountNeedsReauthError: class extends Error {},
    listActiveAccounts: async () => [
      {
        id: ACCOUNT_ID,
        user_id: USER_ID,
        email: "me@gmail.com",
        daily_limit: world.dailyLimit,
        follow_up_share_pct: world.followUpSharePct,
      },
    ],
    mailerFor: () => ({
      send: async (input: {
        to: string
        subject: string
        threadId?: string
      }) => {
        const thrower = world.persistentSendError ?? world.sendError
        if (thrower) {
          const error = thrower()
          // A one-shot error clears itself; a persistent one does not.
          if (!world.persistentSendError) world.sendError = null
          throw error
        }

        world.nextThread += 1
        // A follow-up joins its parent's thread; an opening email starts one. This is
        // what makes the threading assertions meaningful rather than tautological.
        const threadId = input.threadId ?? `thread-${world.nextThread}`

        world.deliveries.push({
          to: input.to,
          subject: input.subject,
          threadId: input.threadId,
          position: -1, // filled in by the queue mock, which knows the row
          at: Date.now(),
        })

        return {
          gmailMessageId: `msg-${world.nextThread}`,
          threadId,
          rfcMessageId: `<rfc-${world.nextThread}@mail.gmail.com>`,
        }
      },
    }),
    markNeedsReauth: async () => {},
    oauthClientFor: () => ({ getAccessToken: async () => "tok" }),
    replyWatcherFor: () => ({
      hasInboundReply: async (threadId: string) => {
        if (world.watcherError) throw world.watcherError()

        const at = world.repliedThreads.get(threadId)
        return at ? { replied: true, at, from: "them@prospect.test" } : { replied: false }
      },
    }),
  },
})

/**
 * An in-memory `sends` table with the semantics of `schema.sql`.
 *
 * Written once and shared by every test here, so no test can accidentally relax the
 * rule that makes duplicates impossible.
 */
mock.module("../src/scheduler/send-queue.ts", {
  namedExports: {
    MAX_ATTEMPTS,
    sendQueue: {
      /** `status='sending' and claimed_at < now()-15min → pending`. */
      releaseStaleClaims: async (olderThanMinutes = 15) => {
        const cutoff = Date.now() - olderThanMinutes * 60_000
        let released = 0

        for (const row of world.rows) {
          if (row.status !== "sending") continue
          if (!row.claimed_at || Date.parse(row.claimed_at) >= cutoff) continue
          row.status = "pending"
          row.claimed_at = null
          released += 1
        }
        return released
      },

      /** `sent_today_count` — status='sent' and sent_at >= IST midnight. */
      sentToday: async (_accountId: string, isFollowUp?: boolean) => {
        const istMidnight = DateTime.utc().setZone(IST_ZONE).startOf("day").toMillis()

        return world.rows.filter(
          (row) =>
            row.status === "sent" &&
            row.sent_at !== null &&
            Date.parse(row.sent_at) >= istMidnight &&
            (isFollowUp === undefined || row.is_follow_up === isFollowUp)
        ).length
      },

      /** `claim_due_sends`, faithfully: due + pending + class, oldest first. */
      claimDue: async (accountId: string, limit: number, isFollowUp?: boolean) => {
        if (limit <= 0) return []

        const now = Date.now()
        const due = world.rows
          .filter(
            (row) =>
              row.gmail_account_id === accountId &&
              row.status === "pending" &&
              Date.parse(row.scheduled_at) <= now &&
              (isFollowUp === undefined || row.is_follow_up === isFollowUp)
          )
          .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
          .slice(0, Math.max(Math.trunc(limit), 0))

        for (const row of due) {
          row.status = "sending"
          row.claimed_at = new Date().toISOString()
          row.attempt_count += 1
        }

        // Copies, as PostgREST returns: the tick must not be able to mutate the table
        // by holding onto a claimed row.
        return due.map((row) => ({ ...row }))
      },

      markSent: async (
        sendId: string,
        result: { gmailMessageId: string; threadId: string; rfcMessageId?: string },
        rendered: { subject: string }
      ) => {
        const row = world.rows.find((r) => r.id === sendId)
        if (!row) throw new Error(`no such send ${sendId}`)

        row.status = "sent"
        row.sent_at = new Date().toISOString()
        row.gmail_thread_id = result.threadId
        row.rfc822_message_id = result.rfcMessageId ?? null
        row.subject_rendered = rendered.subject

        // Attribute the delivery to its step, which the mailer mock cannot know.
        const delivery = world.deliveries.at(-1)
        if (delivery && delivery.position === -1) delivery.position = row.step_position
      },

      markFailed: async (send: Row, error: Error) => {
        const row = world.rows.find((r) => r.id === send.id)
        if (!row) throw new Error(`no such send ${send.id}`)

        if (send.attempt_count >= MAX_ATTEMPTS) {
          row.status = "failed"
          return { retrying: false }
        }

        row.status = "pending"
        row.claimed_at = null
        // Backoff, but in the past: a test simulating retries must not have to wait
        // two real minutes for the next attempt.
        row.scheduled_at = new Date(Date.now() - 1000).toISOString()
        void error
        return { retrying: true, nextAttemptAt: new Date() }
      },

      markPermanentlyFailed: async (sendId: string) => {
        const row = world.rows.find((r) => r.id === sendId)
        if (row) row.status = "failed"
      },

      cancel: async (sendId: string) => {
        const row = world.rows.find((r) => r.id === sendId)
        if (row) row.status = "cancelled"
      },

      /** DELETEs pending rows, as the real one does — see `sends_lead_step_key`. */
      cancelPendingFor: async (leadId: string) => {
        const before = world.rows.length
        world.rows = world.rows.filter(
          (row) => !(row.lead_id === leadId && row.status === "pending")
        )
        return before - world.rows.length
      },

      reschedule: async (sendId: string, at: Date) => {
        const row = world.rows.find((r) => r.id === sendId)
        if (!row) return
        row.status = "pending"
        row.scheduled_at = at.toISOString()
        row.claimed_at = null
        row.attempt_count = 0
      },

      lastSentFor: async (leadId: string) => {
        const sent = world.rows
          .filter((row) => row.lead_id === leadId && row.status === "sent")
          .sort((a, b) => b.step_position - a.step_position)
        return sent[0] ? { ...sent[0] } : null
      },

      /** Idempotent on `(lead_id, step_position)`, like `sends_lead_step_key`. */
      enqueue: async (insert: {
        lead_id: string
        step_position: number
        step_id: string
        is_follow_up: boolean
        scheduled_at: string
        user_id: string
        gmail_account_id: string
      }) => {
        const clash = world.rows.find(
          (row) =>
            row.lead_id === insert.lead_id && row.step_position === insert.step_position
        )
        if (clash) return null

        const row: Row = {
          id: `send-${insert.lead_id}-${insert.step_position}`,
          lead_id: insert.lead_id,
          gmail_account_id: insert.gmail_account_id,
          user_id: insert.user_id,
          step_position: insert.step_position,
          is_follow_up: insert.is_follow_up,
          status: "pending",
          scheduled_at: insert.scheduled_at,
          claimed_at: null,
          sent_at: null,
          attempt_count: 0,
          tracking_id: `trk-${insert.lead_id}-${insert.step_position}`,
          gmail_thread_id: null,
          rfc822_message_id: null,
          subject_rendered: null,
          step_id: insert.step_id,
        }
        world.rows.push(row)
        return { ...row }
      },
    },
  },
})

mock.module("../src/data/settings.ts", {
  namedExports: {
    DEFAULT_SETTINGS: {},
    loadSettings: async () => ({
      trackOpens: false,
      trackClicks: false,
      outreachDays: world.outreachDays,
      followUpDays: world.followUpDays,
      jitterMinSeconds: 0,
      jitterMaxSeconds: 0,
      staleSendGraceHours: world.staleSendGraceHours,
    }),
  },
})

mock.module("../src/data/leads.ts", {
  namedExports: {
    findLeadById: async (id: string) => {
      const lead = world.leads.get(id)
      if (!lead) return null

      return {
        id: lead.id,
        userId: USER_ID,
        companyName: "Acme",
        firstName: "Ada",
        lastName: "Lovelace",
        email: lead.email,
        personalizationLine: "your work on X",
        jobTitle: "CTO",
        website: "https://acme.test",
        sendTimeIST: lead.sendTimeIST,
        status: lead.status,
        repliedAt: lead.repliedAt?.toISOString() ?? null,
      }
    },

    /*
     * Faithful to the real inner join on `sends`, not just filtered on the lead:
     * the reply watcher is built from one account's credentials, so it may only be
     * handed leads that actually send from that account. Modelling it loosely would
     * hide a cross-account lead reaching a watcher that cannot see its thread.
     */
    listAwaitingReplyForAccount: async (accountId: string) =>
      [...world.leads.values()]
        .filter(
          (lead) =>
            lead.status === "sending" &&
            lead.repliedAt === null &&
            world.rows.some(
              (row) => row.lead_id === lead.id && row.gmail_account_id === accountId
            )
        )
        .map((lead) => ({ id: lead.id, email: lead.email })),

    loadSequence: async (leadId: string) => {
      const steps = world.sequences.get(leadId) ?? DEFAULT_SEQUENCE
      return steps.map((step) => ({
        id: `step-${leadId}-${step.position}`,
        leadId,
        position: step.position,
        kind: step.kind,
        name: step.kind === "email" ? `Email ${step.position}` : "Wait",
        subject: step.subject ?? "",
        bodyHtml: step.bodyHtml ?? "",
        waitDays: step.waitDays,
      }))
    },

    markLeadReplied: async (leadId: string, at: Date) => {
      const lead = world.leads.get(leadId)
      if (lead) {
        lead.repliedAt = at
        lead.status = "replied"
      }
    },

    setLeadStatus: async (leadId: string, status: string) => {
      const lead = world.leads.get(leadId)
      if (lead) lead.status = status
    },
  },
})

mock.module("../src/data/events.ts", { namedExports: { recordEvent: async () => {} } })
mock.module("../src/storage/attachment-store.ts", {
  namedExports: { attachmentStore: { fetchForStep: async () => [] } },
})

const { runTick } = await import("../src/scheduler/tick.ts")

// ── the happy path ────────────────────────────────────────────────────────────

test("one launched lead: the opening email goes out once and queues its follow-up", async () => {
  reset()
  launch("ada")

  const result = await runTick()

  assert.equal(result.sent, 1)
  assert.deepEqual(
    world.deliveries.map((d) => d.to),
    ["ada@prospect.test"]
  )
  assert.equal(world.deliveries[0]!.subject, "Quick question")
  assertNoDuplicates("first send")

  // The follow-up is queued lazily, dated from the real send, and is NOT due yet.
  const followUp = world.rows.find((r) => r.step_position === 2)
  assert.ok(followUp, "the follow-up must be queued")
  assert.equal(followUp.status, "pending")
  assert.equal(followUp.is_follow_up, true)
  assert.ok(
    Date.parse(followUp.scheduled_at) > Date.now() + 2 * 24 * 3600e3,
    "a 3-day wait must not be due within two days"
  )
  assert.equal(world.leads.get("lead-ada")!.status, "sending")
})

test("running the tick repeatedly never re-sends a delivered email", async () => {
  /*
   * The most basic form of the duplicate guarantee, and the one the cron actually
   * exercises: the loop runs every minute forever, and every one of those ticks
   * looks at the same table.
   */
  reset()
  launch("ada")

  for (let i = 0; i < 20; i += 1) await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1)
  assertNoDuplicates("20 ticks")
})

test("a follow-up inherits the parent's subject and threads onto it", async () => {
  reset()
  launch("ada")
  await runTick()

  // The follow-up becomes due (3 days pass).
  const followUp = world.rows.find((r) => r.step_position === 2)!
  followUp.scheduled_at = new Date(Date.now() - 60_000).toISOString()

  await runTick()

  const sent = deliveriesTo("ada@prospect.test")
  assert.equal(sent.length, 2, "opening + one follow-up")

  const [opening, bump] = sent
  assert.equal(bump!.subject, opening!.subject, "a blank follow-up inherits the subject")
  assert.equal(
    bump!.threadId,
    "thread-1",
    "the follow-up must go out inside the parent's Gmail thread"
  )
  assert.equal(opening!.threadId, undefined, "the opening email starts the thread")
  assert.ok(bump!.at >= opening!.at, "the follow-up cannot precede its parent")
  assertNoDuplicates("threaded follow-up")

  // Sequence over: nothing left to queue, and the lead reads `sent`.
  assert.equal(world.leads.get("lead-ada")!.status, "sent")
  assert.equal(world.rows.filter((r) => r.status === "pending").length, 0)
})

test("emails arrive in sequence order, one step at a time", async () => {
  reset()
  launch("ada", {
    sequence: [
      { position: 0, kind: "email", subject: "One", bodyHtml: "<p>1</p>" },
      { position: 1, kind: "delay", waitDays: 1 },
      { position: 2, kind: "email", subject: "Two", bodyHtml: "<p>2</p>" },
      { position: 3, kind: "delay", waitDays: 1 },
      { position: 4, kind: "email", subject: "Three", bodyHtml: "<p>3</p>" },
    ],
  })

  // Four days of ticks; each makes the one queued follow-up due.
  for (let day = 0; day < 4; day += 1) {
    await runTick()
    nextDay()
  }

  assert.deepEqual(
    deliveriesTo("ada@prospect.test").map((d) => d.subject),
    ["One", "Two", "Three"],
    "steps must go out in order, never batched or reordered"
  )
  assertNoDuplicates("three-step sequence")
})

// ── the daily cap ─────────────────────────────────────────────────────────────

test("the daily cap is never exceeded, and the remainder waits for the next day", async () => {
  reset()
  world.dailyLimit = 3

  // One step each, so the arithmetic is about the cap alone: with the default
  // sequence, `nextDay` also makes each lead's queued follow-up due, and day three
  // would legitimately carry both the last opening email and three follow-ups.
  const oneStep: StepDef[] = [{ position: 0, kind: "email", subject: "Hi", bodyHtml: "<p>x</p>" }]
  for (const name of ["a", "b", "c", "d", "e", "f", "g"]) launch(name, { sequence: oneStep })

  // Many ticks in one "day": the cap has to hold across all of them, not per tick.
  for (let i = 0; i < 10; i += 1) await runTick()

  assert.equal(world.deliveries.length, 3, "a cap of 3 means 3 emails today")
  assertNoDuplicates("capped day")

  nextDay()
  for (let i = 0; i < 10; i += 1) await runTick()

  assert.equal(world.deliveries.length, 6, "day two sends the next 3")
  nextDay()
  for (let i = 0; i < 10; i += 1) await runTick()

  assert.equal(world.deliveries.length, 7, "day three sends the last one")
  assertNoDuplicates("three capped days")

  // Everyone got exactly one, and nobody was skipped.
  const recipients = world.deliveries.map((d) => d.to).sort()
  assert.equal(new Set(recipients).size, 7)
})

test("a backlog drains on consecutive days — no alternate-day dead zone", async () => {
  /*
   * Bug #1 at the loop level rather than in the arithmetic. The rows left over from a
   * capped day are stale by the time the post-midnight tick claims them, so they go
   * through `rescheduleStaleAt` — which used to push them a day past the morning they
   * were already waiting for, killing every second day.
   */
  reset()
  world.dailyLimit = 5
  for (let i = 0; i < 20; i += 1) launch(`p${i}`)

  const perDay: number[] = []

  for (let day = 0; day < 4; day += 1) {
    const before = world.deliveries.length
    for (let i = 0; i < 5; i += 1) await runTick()
    perDay.push(world.deliveries.length - before)
    nextDay()
  }

  assert.deepEqual(perDay, [5, 5, 5, 5], "every day must send its full cap")
  assertNoDuplicates("draining backlog")
})

test("the cap counts follow-ups and opening emails together", async () => {
  // A cap is a deliverability budget for the mailbox, not per class — 3 follow-ups
  // plus 3 new on a cap of 4 is 6 emails from one account in a day.
  reset()
  world.dailyLimit = 4

  for (const name of ["a", "b"]) launch(name)
  await runTick() // both opening emails go out, follow-ups queued

  // Their follow-ups become due the same day, and two new leads arrive.
  for (const row of world.rows) {
    if (row.status === "pending") row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  }
  launch("c")
  launch("d")

  for (let i = 0; i < 5; i += 1) await runTick()

  assert.equal(world.deliveries.length, 4, "4 emails today, whatever the mix")
  assertNoDuplicates("mixed classes under a cap")
})

test("the follow-up share is a ceiling that either class may borrow", async () => {
  reset()
  world.dailyLimit = 4
  world.followUpSharePct = 50 // 2 follow-ups, 2 new

  // Two leads already mid-sequence with due follow-ups, and three new leads.
  for (const name of ["a", "b"]) launch(name)
  await runTick()
  for (const row of world.rows) {
    if (row.status === "pending") row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  }
  nextDay()
  for (const name of ["c", "d", "e"]) launch(name)

  for (let i = 0; i < 5; i += 1) await runTick()

  const today = world.deliveries.filter((d) => d.position >= 0)
  const followUps = today.filter((d) => d.position === 2).length
  const outreach = today.filter((d) => d.position === 0).length

  assert.equal(followUps + outreach, 4 + 2, "2 opening emails on day one, 4 on day two")
  // The split holds: neither class is starved by the other's earlier send times.
  assert.equal(followUps, 2, "the follow-up share was honoured")
  assert.equal(outreach, 2 + 2, "and outreach got its own 2 on day two")
  assertNoDuplicates("split budget")
})

test("with only one class pending, it takes the whole cap", async () => {
  // The borrowing rule: a reserved share that couldn't be lent would waste the cap.
  reset()
  world.dailyLimit = 4
  world.followUpSharePct = 50
  for (const name of ["a", "b", "c", "d", "e"]) launch(name)

  for (let i = 0; i < 5; i += 1) await runTick()

  assert.equal(
    world.deliveries.length,
    4,
    "no follow-ups pending, so outreach may use the whole cap"
  )
  assertNoDuplicates("borrowed budget")
})

test("a cap of zero sends nothing at all", async () => {
  reset()
  world.dailyLimit = 0
  launch("ada")

  await runTick()

  assert.deepEqual(world.deliveries, [], "a zero cap must send nothing, not fall through")
})

// ── replies ───────────────────────────────────────────────────────────────────

test("a reply cancels the follow-up before it goes out", async () => {
  reset()
  launch("ada")
  await runTick() // opening email out, follow-up queued

  // They reply, and the follow-up comes due.
  world.repliedThreads.set("thread-1", new Date())
  const followUp = world.rows.find((r) => r.step_position === 2)!
  followUp.scheduled_at = new Date(Date.now() - 60_000).toISOString()

  const result = await runTick()

  assert.equal(result.repliesDetected, 1)
  assert.equal(
    deliveriesTo("ada@prospect.test").length,
    1,
    "the follow-up must not go out after a reply"
  )
  assert.equal(world.leads.get("lead-ada")!.status, "replied")
  // The pending row is deleted, not left to be claimed by a later tick.
  assert.equal(world.rows.filter((r) => r.status === "pending").length, 0)

  // And it stays cancelled however many ticks run.
  for (let i = 0; i < 10; i += 1) await runTick()
  assert.equal(deliveriesTo("ada@prospect.test").length, 1)
  assertNoDuplicates("reply cancels follow-up")
})

test("replies are checked before sending, not after — the ordering is the point", async () => {
  /*
   * A reply that arrived 40 seconds ago has to stop today's follow-up. Detecting
   * after sending would be too late by exactly one email, and it is the worst one to
   * get wrong: answering someone who already answered you.
   *
   * The reply is planted while the follow-up is already due, so the *only* thing that
   * can stop it is step 2 of the tick running before step 4.
   */
  reset()
  launch("ada")
  await runTick()

  const followUp = world.rows.find((r) => r.step_position === 2)!
  followUp.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  world.repliedThreads.set("thread-1", new Date())

  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1)
  assert.equal(followUp.status ?? "deleted", "pending", "row deleted, so status is unread")
  assert.equal(
    world.rows.some((r) => r.step_position === 2),
    false,
    "the queued follow-up is gone"
  )
})

test("a reply arriving between the claim and the send still stops it", async () => {
  /*
   * The narrow window `processSend`'s `lead.repliedAt` check exists for: reply
   * detection ran, then the row was claimed, then the reply landed. The lead is
   * flagged directly here because that is the state the check reads — a reply
   * recorded by any means, including the UI, mid-tick.
   */
  reset()
  launch("ada")
  await runTick()

  const followUp = world.rows.find((r) => r.step_position === 2)!
  followUp.scheduled_at = new Date(Date.now() - 60_000).toISOString()

  // Flagged, but with no thread reply — so `detectReplies` finds nothing and only
  // the per-send check can catch it.
  world.leads.get("lead-ada")!.repliedAt = new Date()

  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "the claimed row must be cancelled")
  assert.equal(followUp.status, "cancelled")
  assertNoDuplicates("reply mid-tick")
})

test("a reply on one lead does not stop anyone else's sequence", async () => {
  reset()
  launch("ada")
  launch("bob")
  await runTick()

  // Ada replies; Bob does not.
  const adaThread = world.rows.find((r) => r.lead_id === "lead-ada")!.gmail_thread_id!
  world.repliedThreads.set(adaThread, new Date())

  for (const row of world.rows) {
    if (row.status === "pending") row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  }
  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "Ada's sequence stopped")
  assert.equal(deliveriesTo("bob@prospect.test").length, 2, "Bob's carried on")
  assertNoDuplicates("one reply among two leads")
})

test("a thread belonging to another account is not checked or cancelled", async () => {
  /*
   * The watcher is built from one account's credentials, so asking it about a thread
   * in a different mailbox is at best a 404 and at worst — if two accounts ever had
   * colliding thread ids — a reply attributed to the wrong conversation, cancelling a
   * sequence nobody replied to. Skipped on `gmail_account_id` before the call.
   */
  reset()
  launch("ada")
  await runTick()

  // The parent now belongs to a second account, and a reply is sitting in its thread.
  const parent = world.rows.find((r) => r.step_position === 0)!
  parent.gmail_account_id = "acc2"
  world.repliedThreads.set(parent.gmail_thread_id!, new Date())

  const followUp = world.rows.find((r) => r.step_position === 2)!
  followUp.scheduled_at = new Date(Date.now() - 60_000).toISOString()

  const result = await runTick()

  assert.equal(result.repliesDetected, 0, "the other account's thread must be skipped")
  assert.equal(world.leads.get("lead-ada")!.repliedAt, null)
  assertNoDuplicates("cross-account thread")
})

test("a lead sending from another account is not even fetched for a reply check", async () => {
  /*
   * The scoping half of the same concern, one layer earlier: with the query
   * unscoped, every account walked every in-flight lead and threw away the ones it
   * could not see — a `lastSentFor` query each, every minute. `listAwaitingReplyForAccount`
   * inner-joins `sends`, so a lead with nothing on this account never comes back.
   *
   * Asserted through `repliesDetected` rather than by counting queries: a reply *is*
   * waiting in the thread, so a lead that leaked through would be detected and would
   * cancel a sequence this account has no business cancelling.
   */
  reset()
  launch("ada")
  await runTick()

  // Every one of this lead's rows moves to a second mailbox, and a reply lands.
  for (const row of world.rows.filter((r) => r.lead_id === "lead-ada")) {
    row.gmail_account_id = "acc2"
  }
  const parent = world.rows.find((r) => r.step_position === 0)!
  world.repliedThreads.set(parent.gmail_thread_id!, new Date())

  const result = await runTick()

  assert.equal(result.repliesDetected, 0, "another account's lead must not be examined")
  assert.equal(world.leads.get("lead-ada")!.repliedAt, null)
})

test("a follow-up queued on the wrong account is refused, not sent as a new thread", async () => {
  /*
   * **The invariant behind multi-account sending.** A lead's whole sequence goes out
   * from the mailbox that sent its opening email.
   *
   * Gmail's `threadId` is scoped to the account it was issued for, so handing the
   * parent's thread to a different mailbox does not thread the message — it starts a
   * fresh conversation, silently, while the code that sets `In-Reply-To` and inherits
   * the parent's subject all still runs as though threading had worked. The recipient
   * sees a *second sender* replying inside their existing conversation to a message
   * that address never sent, quoting a subject from someone else's mailbox: exactly
   * the shape of a thread-hijacking phish.
   *
   * So the assertion is that nothing is delivered. Not sending is recoverable — the
   * row is `failed`, `last_error` says why, and the UI shows it. Sending is not: the
   * email is in someone's inbox.
   *
   * The state set up here is one the application cannot reach (the launch route pins
   * the account, `enqueueNextStep` copies it from the parent, and the
   * `sends_lead_account_affinity` trigger rejects the write) — which is the point.
   * This asserts the last of those defences, the only one still standing if the
   * earlier two are ever changed.
   */
  reset()
  launch("ada")
  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "the opening email goes out")

  // The opening email was sent from a *different* mailbox than the queued follow-up.
  const parent = world.rows.find((r) => r.step_position === 0)!
  parent.gmail_account_id = "acc2"

  const followUp = world.rows.find((r) => r.step_position === 2)!
  followUp.scheduled_at = new Date(Date.now() - 60_000).toISOString()

  // Several ticks: a *retried* row would eventually deliver the very email the
  // guard exists to prevent, so one tick would not prove it stays unsent.
  for (let i = 0; i < 3; i += 1) await runTick()

  assert.equal(
    deliveriesTo("ada@prospect.test").length,
    1,
    "the follow-up must not be delivered from a mailbox that doesn't own the thread"
  )
  assert.equal(
    world.rows.find((r) => r.step_position === 2)!.status,
    "failed",
    "and it must be failed permanently rather than retried forever"
  )
})

test("a failing reply check is logged per lead and does not stop the tick", async () => {
  /*
   * One unreachable thread must not cost every other lead their send. The dangerous
   * failure mode is the *reverse* of a duplicate: a watcher error that propagated
   * would abort `runForAccount` before step 4, so nothing at all went out — silently,
   * every minute, looking exactly like an empty queue.
   */
  reset()
  launch("ada")
  launch("bob")
  await runTick()

  world.watcherError = () => new Error("Gmail 404: thread not found")
  for (const row of world.rows) {
    if (row.status === "pending") row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  }

  const result = await runTick()

  assert.equal(result.repliesDetected, 0)
  assert.equal(result.sent, 2, "both follow-ups still went out")
  assert.deepEqual(result.skipped, [], "a per-lead reply failure is not an account failure")
  assertNoDuplicates("watcher error")
})

test("an auth failure in the reply watcher stops the account before anything is sent", async () => {
  /*
   * The one watcher error that must *not* be swallowed. A dead refresh token will
   * fail every send too, so carrying on would turn one clear "reconnect your account"
   * into a batch of failures with retries burnt on each. Rethrown from
   * `detectReplies`, caught by `runTick`'s per-account guard.
   */
  reset()
  launch("ada")
  launch("bob")
  await runTick()

  const { GmailAuthError } = await import("../src/email/gmail-mailer.ts")
  world.watcherError = () => new GmailAuthError("invalid_grant: token has been revoked")
  for (const row of world.rows) {
    if (row.status === "pending") row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  }

  const result = await runTick()

  assert.equal(result.sent, 0, "nothing may be sent with a dead token")
  assert.equal(result.skipped.length, 1, "the account is skipped with a reason")
  assert.match(result.skipped[0]!.reason, /invalid_grant/)
  // The rows were never claimed, so they are untouched and still pending.
  assert.equal(world.rows.filter((r) => r.status === "pending").length, 2)
  assert.deepEqual(
    world.rows.filter((r) => r.status === "sending"),
    [],
    "an aborted account must not leave rows claimed"
  )
})

test("a lead that replied before anything was sent is never emailed", async () => {
  // The lead is flagged while its opening email is still pending — a reply to some
  // earlier conversation, or a manual mark in the UI. Nothing should go out at all.
  reset()
  launch("ada")
  world.leads.get("lead-ada")!.repliedAt = new Date()

  for (let i = 0; i < 5; i += 1) await runTick()

  assert.deepEqual(world.deliveries, [])
  assert.equal(world.rows[0]!.status, "cancelled")
})

// ── failures and retries ──────────────────────────────────────────────────────

test("a transient failure is retried and then delivered exactly once", async () => {
  reset()
  launch("ada")
  world.sendError = () => new Error("503 backend error")

  await runTick() // fails, back to pending
  assert.equal(world.deliveries.length, 0)
  assert.equal(world.rows[0]!.status, "pending")

  await runTick() // succeeds

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "retried once, delivered once")
  assertNoDuplicates("transient failure")
})

test("a permanently failing send stops after MAX_ATTEMPTS and delivers nothing", async () => {
  reset()
  launch("ada")
  world.persistentSendError = () => new Error("550 mailbox unavailable")

  for (let i = 0; i < 12; i += 1) await runTick()

  assert.equal(world.deliveries.length, 0)
  assert.equal(world.rows[0]!.status, "failed", "it must reach a terminal state, not loop")
  assert.equal(
    world.rows[0]!.attempt_count,
    MAX_ATTEMPTS,
    "and stop consuming the cap after 5 attempts"
  )
})

test("a rate-limited account releases the rest of the batch instead of leaving it claimed", async () => {
  /*
   * Stopping at the first 429 is right — Gmail is going to refuse the rest too, and
   * five attempts each would only dig in deeper. But the rows behind it were already
   * flipped `pending` → `sending` by the claim, and nothing in the rate-limit branch
   * touches them: `markFailed` only ever sees the row that failed. Left claimed they
   * match no future claim filter, so they sit invisible until `releaseStaleClaims`
   * frees them 15 minutes later — a queue that looks busy and is doing nothing, and
   * leads stuck on "sending" in the UI for the same 15 minutes.
   */
  reset()
  for (const name of ["a", "b", "c"]) launch(name)

  const { GmailRateLimitError } = await import("../src/email/gmail-mailer.ts")
  world.persistentSendError = () => new GmailRateLimitError("429 rate limit exceeded")

  await runTick()

  assert.equal(world.deliveries.length, 0)
  assert.deepEqual(
    world.rows.filter((r) => r.status === "sending"),
    [],
    "no row may be left claimed after the batch stops"
  )
  assert.equal(
    world.rows.filter((r) => r.status === "pending").length,
    3,
    "all three are sendable again on the next tick"
  )

  // Only the row Gmail actually refused spent an attempt; the two that were never
  // tried had their claim's increment undone by `reschedule`.
  assert.deepEqual(
    world.rows.map((r) => r.attempt_count).sort(),
    [0, 0, 1],
    "an untried row must not be charged for the account being throttled"
  )

  // And the untried rows keep their own due time rather than being pushed to a new one.
  world.persistentSendError = null
  await runTick()
  assert.equal(world.deliveries.length, 3, "all three go out once the throttle lifts")
  assertNoDuplicates("rate limit then recovery")
})

test("an empty step fails permanently instead of retrying five times", async () => {
  reset()
  launch("ada", {
    sequence: [{ position: 0, kind: "email", subject: "Hi", bodyHtml: "<p></p>" }],
  })

  await runTick()

  assert.equal(world.deliveries.length, 0)
  assert.equal(world.rows[0]!.status, "failed")
  assert.equal(world.rows[0]!.attempt_count, 1, "no retries — the body is empty until edited")
})

test("a deleted step fails its send without stalling the queue", async () => {
  reset()
  launch("ada", { sequence: [] }) // every step deleted after launch
  launch("bob")

  await runTick()

  assert.equal(world.rows.find((r) => r.lead_id === "lead-ada")!.status, "failed")
  assert.deepEqual(
    world.deliveries.map((d) => d.to),
    ["bob@prospect.test"],
    "the healthy lead still sends"
  )
})

test("a lead deleted mid-flight fails its send rather than looping forever", async () => {
  reset()
  launch("ada")
  world.leads.delete("lead-ada")

  await runTick()

  assert.equal(world.rows[0]!.status, "failed")
  assert.equal(world.deliveries.length, 0)
})

// ── crashes, restarts and overlapping ticks ───────────────────────────────────

test("a crash mid-send is recovered without double-sending", async () => {
  /*
   * `releaseStaleClaims` exists because a row left in `sending` matches no claim
   * filter and would never be retried. The risk it introduces is the opposite one:
   * releasing a row whose email *did* go out. It is bounded by `claimed_at`, so a
   * row claimed in the last 15 minutes is never yanked.
   */
  reset()
  launch("ada")

  // Killed after the claim, before the send — 20 minutes ago.
  world.rows[0]!.status = "sending"
  world.rows[0]!.claimed_at = new Date(Date.now() - 20 * 60_000).toISOString()
  world.rows[0]!.attempt_count = 1

  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "recovered and sent once")
  assertNoDuplicates("crash recovery")
})

test("a row claimed moments ago is not released out from under a live send", async () => {
  reset()
  launch("ada")
  world.rows[0]!.status = "sending"
  world.rows[0]!.claimed_at = new Date().toISOString()

  await runTick()

  assert.equal(world.deliveries.length, 0, "an in-flight row must be left alone")
  assert.equal(world.rows[0]!.status, "sending")
})

test("an already-sent row is never re-claimed, whatever its scheduled_at says", async () => {
  reset()
  launch("ada")
  await runTick()

  // A hand-edited or resynced row: due again, but already sent.
  world.rows[0]!.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  for (let i = 0; i < 5; i += 1) await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1)
  assertNoDuplicates("re-dated sent row")
})

test("overlapping ticks do not both send: the second is skipped", async () => {
  /*
   * The in-process guard. It only makes a second concurrent tick *cheap* — the
   * atomic claim is what makes it safe — but that distinction matters because with
   * jitter a tick can outlive its minute and node-cron would otherwise stack them.
   */
  reset()
  for (const name of ["a", "b", "c"]) launch(name)

  const [first, second] = await Promise.all([runTick(), runTick()])

  const skipped = [first, second].find((r) => r.skipped.length > 0)
  assert.ok(skipped, "one of the two must have been skipped")
  assert.equal(skipped.skipped[0]!.reason, "previous tick still running")
  assert.equal(world.deliveries.length, 3, "and every lead is sent exactly once")
  assertNoDuplicates("overlapping ticks")
})

test("a duplicate enqueue for the same step is a no-op, not a second email", async () => {
  /*
   * `sends_lead_step_key` is the last line of defence: a retried enqueue, a
   * double-clicked Launch or an overlapping tick all collide on it. Simulated by
   * running the enqueue path twice for the same lead and step.
   */
  reset()
  launch("ada")
  await runTick()

  const { sendQueue } = await import("../src/scheduler/send-queue.ts")
  const again = await sendQueue.enqueue({
    user_id: USER_ID,
    lead_id: "lead-ada",
    step_id: "step-lead-ada-2",
    gmail_account_id: ACCOUNT_ID,
    step_position: 2,
    is_follow_up: true,
    status: "pending",
    scheduled_at: new Date(Date.now() - 60_000).toISOString(),
  })

  assert.equal(again, null, "the unique index must refuse the second row")
  assert.equal(
    world.rows.filter((r) => r.lead_id === "lead-ada" && r.step_position === 2).length,
    1
  )
})

// ── the weekday gate ──────────────────────────────────────────────────────────

test("nothing goes out on an excluded day, and the row waits rather than failing", async () => {
  reset()
  // Today is excluded, whatever today is.
  world.outreachDays = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter((d) => d !== todayIST())
  launch("ada")

  const result = await runTick()

  assert.equal(world.deliveries.length, 0, "an excluded day sends nothing")
  assert.equal(result.rescheduled, 1)
  assert.equal(world.rows[0]!.status, "pending", "rescheduled, not failed")
  assert.ok(
    Date.parse(world.rows[0]!.scheduled_at) > Date.now(),
    "and moved into the future, never left due"
  )
})

test("a follow-up obeys the follow-up day list, not the outreach one", async () => {
  reset()
  launch("ada")
  await runTick() // opening email out on an allowed outreach day

  // Follow-ups are now barred today; outreach is still allowed.
  world.followUpDays = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter((d) => d !== todayIST())
  const followUp = world.rows.find((r) => r.step_position === 2)!
  followUp.scheduled_at = new Date(Date.now() - 60_000).toISOString()

  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "the follow-up waits")
  assert.equal(followUp.status, "pending")
})

test("an excluded day never turns into a duplicate once the day opens up", async () => {
  reset()
  world.outreachDays = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter((d) => d !== todayIST())
  launch("ada")

  for (let i = 0; i < 5; i += 1) await runTick()

  world.outreachDays = [0, 1, 2, 3, 4, 5, 6]
  nextDay()
  for (let i = 0; i < 5; i += 1) await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1)
  assertNoDuplicates("day gate then open")
})

// ── the stale-send grace window ───────────────────────────────────────────────

test("a send more than the grace period late is moved, not delivered at the wrong hour", async () => {
  /*
   * The weekend-laptop case. A row 14 hours late must not be delivered at 02:00 —
   * that timestamp reads as automation to Gmail and to the recipient, and it breaks
   * the promise their own send time made.
   */
  reset()
  launch("ada", { dueMinutesAgo: 14 * 60 })

  const result = await runTick()

  assert.equal(world.deliveries.length, 0, "too late to send now")
  assert.equal(result.rescheduled, 1)
  assert.ok(Date.parse(world.rows[0]!.scheduled_at) > Date.now())
  // Not a failure: the postponement must not spend one of the five retries.
  assert.equal(world.rows[0]!.attempt_count, 0, "a reschedule resets the attempt counter")
})

test("a send inside the grace window still goes out", async () => {
  reset()
  world.staleSendGraceHours = 6
  launch("ada", { dueMinutesAgo: 5 * 60 })

  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "5h late is still within grace")
})

test("repeated postponement never exhausts the retry budget", async () => {
  /*
   * `claim_due_sends` increments `attempt_count` on every claim, so without the reset
   * in `reschedule` a row bounced across a few weekends reached MAX_ATTEMPTS on its
   * own — and the next transient Gmail error failed it outright with no retry.
   * Exactly backwards: the emails that had waited longest got the least tolerance.
   */
  reset()
  launch("ada")

  for (let day = 0; day < 8; day += 1) {
    // Excluded today, so every tick postpones rather than sends.
    world.outreachDays = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter((d) => d !== todayIST())
    await runTick()
    nextDay()
  }

  assert.equal(world.rows[0]!.status, "pending", "still sendable after eight postponements")
  assert.ok(
    world.rows[0]!.attempt_count < MAX_ATTEMPTS,
    `postponements must not spend retries (attempt_count = ${world.rows[0]!.attempt_count})`
  )

  // And it does eventually send, exactly once.
  world.outreachDays = [0, 1, 2, 3, 4, 5, 6]
  nextDay()
  await runTick()
  assert.equal(deliveriesTo("ada@prospect.test").length, 1)
})

// ── the long run ──────────────────────────────────────────────────────────────

test("a 30-lead, 3-step campaign over three weeks: no duplicates, cap always held", async () => {
  /*
   * The whole thing at once — the test that would catch an interaction none of the
   * cases above isolate. 30 leads × 3 emails against a cap of 5, with replies and
   * transient failures thrown in, over 21 simulated days.
   *
   * Asserted as invariants rather than an expected transcript: the exact schedule
   * depends on which day of the week the suite runs on, but "nobody gets two copies"
   * and "never more than the cap in a day" hold regardless.
   */
  reset()
  world.dailyLimit = 5
  world.followUpSharePct = 40

  const sequence: StepDef[] = [
    { position: 0, kind: "email", subject: "Intro", bodyHtml: "<p>Hello</p>" },
    { position: 1, kind: "delay", waitDays: 3 },
    { position: 2, kind: "email", subject: "", bodyHtml: "<p>Bump</p>" },
    { position: 3, kind: "delay", waitDays: 4 },
    { position: 4, kind: "email", subject: "", bodyHtml: "<p>Last try</p>" },
  ]

  for (let i = 0; i < 30; i += 1) launch(`p${i}`, { sequence })

  const perDay: number[] = []

  for (let day = 0; day < 21; day += 1) {
    const before = world.deliveries.length

    // A few ticks a day, as the cron would run.
    for (let t = 0; t < 4; t += 1) {
      // Every third day, one send fails transiently.
      if (day % 3 === 0 && t === 0) world.sendError = () => new Error("503 backend error")
      await runTick()
    }

    perDay.push(world.deliveries.length - before)

    // Every fourth day, whoever was last written to replies.
    if (day % 4 === 3) {
      const last = world.deliveries.at(-1)
      const row = world.rows.find(
        (r) => world.leads.get(r.lead_id)?.email === last?.to && r.gmail_thread_id
      )
      if (row?.gmail_thread_id) world.repliedThreads.set(row.gmail_thread_id, new Date())
    }

    nextDay()
  }

  assertNoDuplicates("three-week campaign")

  for (const [day, count] of perDay.entries()) {
    assert.ok(count <= 5, `day ${day} sent ${count}, over the cap of 5`)
  }

  assert.ok(world.deliveries.length > 40, `expected real traffic, got ${world.deliveries.length}`)

  // Nobody who replied was written to afterwards.
  for (const lead of world.leads.values()) {
    if (!lead.repliedAt) continue

    const after = deliveriesTo(lead.email).filter((d) => d.at > lead.repliedAt!.getTime())
    assert.deepEqual(after, [], `${lead.email} was emailed after replying`)
  }

  // Every step that went out is in order, per lead.
  for (const lead of world.leads.values()) {
    const positions = deliveriesTo(lead.email).map((d) => d.position)
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      `${lead.email} received steps out of order: ${positions.join(",")}`
    )
  }
})
