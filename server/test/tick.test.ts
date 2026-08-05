import test, { mock } from "node:test"
import assert from "node:assert/strict"

/**
 * Regression tests for the ways the send loop used to misbehave badly enough to be
 * worth mocking the entire world for. Run with `npm test`.
 *
 * The real `runTick` is driven end to end with every collaborator replaced, because
 * these bugs lived in **control flow** rather than in a calculation — which try
 * block a throw lands in, and how far up it travels. A unit test of any single
 * function would have missed all of them, and all were found by reading rather than
 * by failing.
 *
 *  1. **A sent email must be delivered exactly once.** `enqueueNextStep` used to run
 *     inside the try that catches send failures, so a throw *after* `markSent` was
 *     handled as a send failure: the row went back to `pending`, the next tick
 *     re-claimed it, and the recipient got five identical emails before
 *     `MAX_ATTEMPTS` stopped it. Reachable from one Settings click, because
 *     `followUpSendAt` throws on an empty `follow_up_days` — which the day picker
 *     allowed.
 *
 *  2. **One bad row must not stop the queue.** The weekday gate and the stale-send
 *     grace window call `rescheduleStaleAt` *outside* `processSend`'s try, and it
 *     throws on a malformed `send_time_ist`. That escaped `runForAccount` and
 *     `runTick` into the cron callback's `.catch()`, abandoning the rest of the
 *     batch and every later account — every minute, forever, behind a single log
 *     line.
 *
 *  3. **Nor must a failed *write* after a successful delivery.** `markSent` was in
 *     the same try as `mailer.send`, so one dropped Supabase statement looked
 *     exactly like the email never having gone out — same five copies. This is the
 *     most ordinary of the three: it needs nothing more than a connection reset on a
 *     loop that runs every minute.
 *
 * Every test here was confirmed to fail against its pre-fix code, which is the only
 * thing that makes them worth keeping.
 */
const ACCOUNT = {
  id: "acc1", user_id: "u1", email: "me@gmail.com",
  daily_limit: 10, follow_up_share_pct: 50,
}

// ── recording state ───────────────────────────────────────────────────────────
/** Every address `mailer.send` was called with — the list a duplicate shows up in. */
let deliveries: string[] = []
let statusOf: Record<string, string> = {}
let rows: SendRowStub[] = []

/**
 * Make every `markSent` write fail, standing in for Supabase being unreachable for
 * the one statement between a delivered email and the row that records it.
 */
let markSentFails = false
/** How many times the tick tried to record a send — a retry loop shows up as >1. */
let markSentAttempts = 0

/** Only the `sends` columns the tick actually reads. */
interface SendRowStub {
  id: string
  lead_id: string
  status: string
  scheduled_at: string
  attempt_count: number
  is_follow_up: boolean
  step_position: number
  [key: string]: unknown
}

/** Due a minute ago by default, so the claim takes it and the grace window passes. */
function makeRow(id: string, over: Partial<SendRowStub> = {}): SendRowStub {
  return {
    id, lead_id: `lead-${id}`, gmail_account_id: "acc1", user_id: "u1",
    step_position: 0, is_follow_up: false, status: "pending",
    scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    attempt_count: 0, tracking_id: `trk-${id}`, gmail_thread_id: null,
    rfc822_message_id: null, subject_rendered: null, ...over,
  }
}

/** Move a row's status in both the queue and the assertion record. */
function setStatus(id: string, status: string): void {
  statusOf[id] = status
  const row = rows.find((r) => r.id === id)
  if (row) row.status = status
}

// ── mocks ─────────────────────────────────────────────────────────────────────

/**
 * Silence the logger — see the same block in `send-loop.test.ts`. The real one
 * spawns a pino-pretty worker thread that outlives the tests, so the file passes
 * every assertion and is then killed for taking minutes to exit.
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
    listActiveAccounts: async () => [ACCOUNT],
    mailerFor: () => ({
      send: async (input: { to: string }) => {
        deliveries.push(input.to)
        return { gmailMessageId: "m1", threadId: "t1", rfcMessageId: "<r1>" }
      },
    }),
    markNeedsReauth: async () => {},
    oauthClientFor: () => ({ getAccessToken: async () => "tok" }),
    replyWatcherFor: () => ({ hasInboundReply: async () => ({ replied: false }) }),
  },
})

/**
 * An in-memory `sends` table. Faithful on the two points these tests turn on:
 * `claimDue` only ever takes `pending` rows and increments `attempt_count` (as
 * `claim_due_sends` does), and `markFailed` resets a row to `pending` until
 * `MAX_ATTEMPTS` — which is exactly how an already-sent row got re-delivered.
 */
mock.module("../src/scheduler/send-queue.ts", {
  namedExports: {
    MAX_ATTEMPTS: 5,
    sendQueue: {
      releaseStaleClaims: async () => 0,
      sentToday: async () => 0,
      claimDue: async (_accountId: string, limit: number, isFollowUp?: boolean) => {
        const take = rows
          .filter(
            (r) =>
              r.status === "pending" &&
              (isFollowUp === undefined || r.is_follow_up === isFollowUp)
          )
          .slice(0, Math.max(limit, 0))

        for (const row of take) {
          row.status = "sending"
          row.attempt_count += 1
        }
        return take
      },
      markSent: async (id: string) => {
        markSentAttempts += 1
        if (markSentFails) throw new Error("fetch failed: PostgREST unreachable")
        setStatus(id, "sent")
      },
      markFailed: async (send: SendRowStub) => {
        if (send.attempt_count >= 5) {
          setStatus(send.id, "failed")
          return { retrying: false }
        }
        setStatus(send.id, "pending")
        return { retrying: true, nextAttemptAt: new Date() }
      },
      markPermanentlyFailed: async (id: string) => setStatus(id, "failed"),
      cancel: async (id: string) => setStatus(id, "cancelled"),
      cancelPendingFor: async () => 0,
      reschedule: async (id: string) => setStatus(id, "pending"),
      lastSentFor: async () => null,
      enqueue: async () => null,
    },
  },
})

mock.module("../src/data/settings.ts", {
  namedExports: {
    DEFAULT_SETTINGS: {},
    /*
     * `followUpDays: []` is the trigger for test 1 — the state one click on the last
     * enabled follow-up day used to produce, before the picker locked it and the
     * column gained a CHECK. Outreach days stay full so the weekday gate lets the
     * opening email through and the failure lands where it belongs: in the *enqueue*
     * of the next step, after the email has already gone out.
     */
    loadSettings: async () => ({
      trackOpens: false, trackClicks: false,
      outreachDays: [0, 1, 2, 3, 4, 5, 6], followUpDays: [],
      jitterMinSeconds: 0, jitterMaxSeconds: 0, staleSendGraceHours: 6,
    }),
  },
})

mock.module("../src/data/leads.ts", {
  namedExports: {
    findLeadById: async (id: string) => ({
      id, userId: "u1", companyName: "Acme", firstName: "Ada", lastName: "L",
      email: `${id}@x.com`, personalizationLine: "p", jobTitle: "CTO",
      website: "https://acme.com",
      // "9:3" passes no validation the app applies, but the column CHECK is the only
      // thing enforcing that — a hand-edited row reaches the tick looking like this.
      sendTimeIST: id === "lead-bad" ? "9:3" : "09:30",
      status: "queued", repliedAt: null,
    }),
    listAwaitingReplyForAccount: async () => [],
    // Two email steps, so step 0 going out has a step 1 to enqueue — without which
    // test 1 would take the "sequence complete" path and never reach the throw.
    loadSequence: async () => [
      { id: "s0", position: 0, kind: "email", subject: "Hi", bodyHtml: "<p>Hello</p>", waitDays: undefined },
      { id: "s1", position: 1, kind: "email", subject: "", bodyHtml: "<p>Bump</p>", waitDays: 3 },
    ],
    markLeadReplied: async () => {}, setLeadStatus: async () => {},
  },
})

mock.module("../src/data/events.ts", { namedExports: { recordEvent: async () => {} } })
mock.module("../src/storage/attachment-store.ts", {
  namedExports: { attachmentStore: { fetchForStep: async () => [] } },
})

// Imported after the mocks are registered, which is the whole reason this is a
// top-level await rather than a static import.
const { runTick } = await import("../src/scheduler/tick.ts")

function reset(): void {
  deliveries = []
  statusOf = {}
  markSentFails = false
  markSentAttempts = 0
}

test("an email is delivered exactly once even when queuing the next step throws", async () => {
  reset()
  rows = [makeRow("A")]

  // Six ticks: one more than MAX_ATTEMPTS, so a row that was being re-queued would
  // have exhausted its retries and delivered five copies by now.
  for (let i = 0; i < 6; i += 1) await runTick()

  assert.deepEqual(deliveries, ["lead-A@x.com"], "must be delivered exactly once")
  assert.equal(statusOf["A"], "sent", "row must stay sent, not be reset to pending")
})

test("a delivered email is not re-sent when recording it fails", async () => {
  reset()
  markSentFails = true
  rows = [makeRow("A")]

  // Six ticks, as above: enough for a re-claimed row to exhaust MAX_ATTEMPTS.
  for (let i = 0; i < 6; i += 1) await runTick()

  assert.deepEqual(
    deliveries,
    ["lead-A@x.com"],
    "one dropped write must not become five emails in a prospect's inbox"
  )
  assert.equal(markSentAttempts, 1, "the row must not be re-claimed and re-sent")
  /*
   * `failed` on a row whose email *was* delivered is the deliberate choice, not an
   * oversight: it is the only status that stops a retry, and a retry costs the
   * recipient a duplicate. `last_error` carries the truth.
   */
  assert.equal(statusOf["A"], "failed", "and it must end up in a terminal state")
})

test("one unscheduleable row does not stop the rest of the batch", async () => {
  reset()
  /*
   * "bad" is both malformed *and* 20 hours late, so it reaches the stale-send grace
   * branch and calls `rescheduleStaleAt` — which throws outside `processSend`'s own
   * try. It is listed first so that, unhandled, it takes "good" down with it.
   */
  rows = [
    makeRow("bad", {
      lead_id: "lead-bad",
      scheduled_at: new Date(Date.now() - 20 * 3600e3).toISOString(),
    }),
    makeRow("good"),
  ]

  const result = await runTick()

  assert.equal(statusOf["bad"], "failed", "the broken row is failed, not left in sending")
  assert.deepEqual(deliveries, ["lead-good@x.com"], "the healthy send still goes out")
  assert.equal(result.sent, 1)
})
