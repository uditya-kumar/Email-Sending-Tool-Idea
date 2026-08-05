import test, { mock } from "node:test"
import assert from "node:assert/strict"
import { DateTime } from "luxon"
import { IST_ZONE, toWeekday } from "../../shared/time.ts"
import type { Weekday } from "../../shared/types.ts"

/**
 * The send loop with **several** Gmail accounts connected.
 *
 * `send-loop.test.ts` drives the same `runTick` but through a world with exactly one
 * account, so nothing in it can observe the rules that only exist because there are
 * more: per-account caps, per-account claim isolation, one account's failure not
 * costing the others their tick, and above all **thread affinity** — a lead's whole
 * sequence leaving from the mailbox that sent its opening email.
 *
 * The invariant this file exists for, stated once:
 *
 *   > **No recipient is ever emailed by two different addresses.**
 *
 * Not "usually", and not "unless something fails". Gmail's `threadId` is scoped to
 * the account it was issued for, so a follow-up sent from a different mailbox does
 * not thread — it silently starts a new conversation while `In-Reply-To` and the
 * inherited subject still apply. The recipient sees a second sender replying inside
 * their thread to a message that address never sent, which is what a thread-hijacking
 * phish looks like. Every test here asserts it via `assertOneSenderPerRecipient`,
 * including the ones nominally about something else, for the same reason
 * `send-loop.test.ts` asserts no-duplicates everywhere: it is the failure that cannot
 * be walked back once it is in someone's inbox.
 *
 * ## Why the mocks are shaped this way
 *
 * `mailerFor(account)` is given the account, so the mock closes over it and stamps
 * every delivery with the address that actually sent it. That is what makes the
 * affinity assertions real rather than tautological — they read the sender off the
 * delivery, not off the row the test set up.
 *
 * `claimDue` filters on `gmail_account_id` exactly as `claim_due_sends` does. That
 * filter *is* the isolation guarantee, so a mock that ignored it would turn every
 * test here green for the wrong reason.
 */

// ── the world ─────────────────────────────────────────────────────────────────

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

/** A delivered email, with the mailbox it actually left from. */
interface Delivery {
  to: string
  /** The sending account's address — the whole point of this file. */
  from: string
  accountId: string
  subject: string
  threadId: string | undefined
  position: number
  at: number
}

interface AccountState {
  id: string
  email: string
  dailyLimit: number
  followUpSharePct: number
  /** Make `authorize` fail for this account, as a dead refresh token does. */
  authFails?: boolean
  /** Make every send from this account throw. */
  sendError?: () => Error
}

const USER_ID = "u1"
const MAX_ATTEMPTS = 5

const world = {
  rows: [] as Row[],
  leads: new Map<string, LeadState>(),
  deliveries: [] as Delivery[],
  accounts: [] as AccountState[],
  /** Threads a reply has landed in, keyed by Gmail thread id. */
  repliedThreads: new Map<string, Date>(),
  /** Which account ids each reply watcher was asked to check — isolation evidence. */
  watcherCalls: [] as { accountId: string; threadId: string }[],
  outreachDays: [] as Weekday[],
  followUpDays: [] as Weekday[],
  staleSendGraceHours: 6,
  nextThread: 0,
}

function todayIST(): Weekday {
  return toWeekday(DateTime.utc().setZone(IST_ZONE))
}

const DEFAULT_SEQUENCE = [
  { position: 0, kind: "email" as const, subject: "Quick question", bodyHtml: "<p>Hi</p>" },
  { position: 1, kind: "delay" as const, waitDays: 3 },
  // Blank subject: the ordinary shape of a follow-up, which inherits the parent's.
  { position: 2, kind: "email" as const, subject: "", bodyHtml: "<p>Bumping</p>" },
]

/** Two active accounts with equal caps, which is the default for these tests. */
function reset(accounts?: AccountState[]): void {
  world.rows = []
  world.leads.clear()
  world.deliveries = []
  world.repliedThreads.clear()
  world.watcherCalls = []
  world.accounts = accounts ?? [
    { id: "acc-a", email: "a@gmail.com", dailyLimit: 10, followUpSharePct: 50 },
    { id: "acc-b", email: "b@gmail.com", dailyLimit: 10, followUpSharePct: 50 },
  ]
  world.outreachDays = [0, 1, 2, 3, 4, 5, 6]
  world.followUpDays = [0, 1, 2, 3, 4, 5, 6]
  world.staleSendGraceHours = 6
  world.nextThread = 0
}

/**
 * A launched lead whose opening email is queued on `accountId` and due a minute ago.
 *
 * The account is passed in rather than balanced, because `runTick` never assigns one
 * — the launch route does (`pick-account.ts`, covered by `assign-account.test.ts`).
 * What this file tests is that the tick *honours* the assignment.
 */
function launch(name: string, accountId: string, over: { dueMinutesAgo?: number } = {}): void {
  const leadId = `lead-${name}`

  world.leads.set(leadId, {
    id: leadId,
    email: `${name}@prospect.test`,
    status: "scheduled",
    repliedAt: null,
    sendTimeIST: "09:30",
  })

  world.rows.push({
    id: `send-${name}-0`,
    lead_id: leadId,
    gmail_account_id: accountId,
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
 * Advance to the next IST day: clear today's send counts and make the **backlog** of
 * opening emails due.
 *
 * Deliberately does not touch queued follow-ups. They carry a real multi-day wait, so
 * a test that let `nextDay()` pull them forward would be asserting against a day that
 * cannot happen — and the counts would silently absorb follow-ups the test thought
 * were openings. A test that wants one due says so with `makeFollowUpDue`.
 */
function nextDay(): void {
  const yesterday = new Date(Date.now() - 26 * 3600e3).toISOString()

  for (const row of world.rows) {
    if (row.status === "pending" && !row.is_follow_up) {
      row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
    }
    if (row.status === "sent") row.sent_at = yesterday
  }
}

/** Make a lead's queued follow-up due now. */
function makeFollowUpDue(name: string): Row {
  const row = world.rows.find((r) => r.lead_id === `lead-${name}` && r.step_position === 2)
  assert.ok(row, `no follow-up queued for ${name}`)
  row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
  return row
}

function deliveriesTo(email: string): Delivery[] {
  return world.deliveries.filter((d) => d.to === email)
}

function sentFrom(accountId: string): Delivery[] {
  return world.deliveries.filter((d) => d.accountId === accountId)
}

/**
 * **The invariant.** Every recipient has been emailed by exactly one address.
 *
 * Asserted in every test in this file, whatever it is nominally about.
 */
function assertOneSenderPerRecipient(context: string): void {
  const senders = new Map<string, Set<string>>()

  for (const delivery of world.deliveries) {
    const set = senders.get(delivery.to) ?? new Set<string>()
    set.add(delivery.from)
    senders.set(delivery.to, set)
  }

  const split = [...senders.entries()]
    .filter(([, from]) => from.size > 1)
    .map(([to, from]) => `${to} ← ${[...from].join(" + ")}`)

  assert.deepEqual(
    split,
    [],
    `${context}: a recipient was emailed by more than one address — ${split.join("; ")}`
  )
}

/** No address is written to twice for the same step. */
function assertNoDuplicates(context: string): void {
  const seen = new Map<string, number>()

  for (const delivery of world.deliveries) {
    const key = `${delivery.to}#${delivery.position}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }

  const duplicated = [...seen.entries()].filter(([, count]) => count > 1)
  assert.deepEqual(duplicated, [], `${context}: duplicate delivery — ${JSON.stringify(duplicated)}`)
}

// ── mocks ─────────────────────────────────────────────────────────────────────

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

class AccountNeedsReauthError extends Error {}

mock.module("../src/email/accounts.ts", {
  namedExports: {
    AccountNeedsReauthError,

    listActiveAccounts: async () =>
      world.accounts.map((account) => ({
        id: account.id,
        user_id: USER_ID,
        email: account.email,
        daily_limit: account.dailyLimit,
        follow_up_share_pct: account.followUpSharePct,
      })),

    /*
     * Closes over the account it was built for and stamps it onto every delivery.
     * This is what lets a test read the *actual* sender off the email rather than
     * assuming the row it set up was honoured.
     */
    mailerFor: (account: { id: string; email: string }) => ({
      send: async (input: { to: string; subject: string; threadId?: string }) => {
        const state = world.accounts.find((a) => a.id === account.id)
        if (state?.sendError) throw state.sendError()

        world.nextThread += 1
        const threadId = input.threadId ?? `thread-${account.id}-${world.nextThread}`

        world.deliveries.push({
          to: input.to,
          from: account.email,
          accountId: account.id,
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

    oauthClientFor: (account: { id: string; email: string }) => ({
      getAccessToken: async () => {
        const state = world.accounts.find((a) => a.id === account.id)
        if (state?.authFails) throw new Error("invalid_grant")
        return "tok"
      },
    }),

    /*
     * Bound to one account, and records which one asked about which thread. A watcher
     * built from account A's credentials cannot read a thread in account B's mailbox,
     * so being *handed* one is the bug — hence the recording rather than just the
     * answer.
     */
    replyWatcherFor: (account: { id: string }) => ({
      hasInboundReply: async (threadId: string) => {
        world.watcherCalls.push({ accountId: account.id, threadId })

        const at = world.repliedThreads.get(threadId)
        return at ? { replied: true, at, from: "them@prospect.test" } : { replied: false }
      },
    }),
  },
})

mock.module("../src/scheduler/send-queue.ts", {
  namedExports: {
    MAX_ATTEMPTS,
    sendQueue: {
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

      /** Per account, as `sent_today_count` is — the cap is not shared. */
      sentToday: async (accountId: string, isFollowUp?: boolean) => {
        const istMidnight = DateTime.utc().setZone(IST_ZONE).startOf("day").toMillis()

        return world.rows.filter(
          (row) =>
            row.gmail_account_id === accountId &&
            row.status === "sent" &&
            row.sent_at !== null &&
            Date.parse(row.sent_at) >= istMidnight &&
            (isFollowUp === undefined || row.is_follow_up === isFollowUp)
        ).length
      },

      /**
       * `claim_due_sends`, including its `gmail_account_id = p_account_id` filter.
       *
       * That filter is the isolation guarantee: one account's tick cannot pick up
       * another's rows even when it has spare capacity and the other is capped.
       */
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

        return due.map((row) => ({ ...row }))
      },

      countActiveLeads: async (accountId: string) =>
        new Set(
          world.rows
            .filter(
              (row) =>
                row.gmail_account_id === accountId &&
                (row.status === "pending" || row.status === "sending")
            )
            .map((row) => row.lead_id)
        ).size,

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
        row.scheduled_at = new Date(Date.now() - 1000).toISOString()
        void error
        return { retrying: true, nextAttemptAt: new Date() }
      },

      markPermanentlyFailed: async (sendId: string, error?: Error) => {
        const row = world.rows.find((r) => r.id === sendId)
        if (row) row.status = "failed"
        void error
      },

      cancel: async (sendId: string) => {
        const row = world.rows.find((r) => r.id === sendId)
        if (row) row.status = "cancelled"
      },

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

      /**
       * Idempotent on `(lead_id, step_position)`, and — like the real table — it
       * enforces `sends_lead_account_affinity`: a row naming a different account
       * than the lead's other sends is rejected.
       *
       * Modelled here because the trigger is the last line of defence, and a mock
       * that silently accepted the write would let a test "pass" against a state the
       * database would never hold.
       */
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
          (row) => row.lead_id === insert.lead_id && row.step_position === insert.step_position
        )
        if (clash) return null

        const pinned = world.rows.find((row) => row.lead_id === insert.lead_id)
        if (pinned && pinned.gmail_account_id !== insert.gmail_account_id) {
          throw new Error(
            `lead ${insert.lead_id} already sends from Gmail account ` +
              `${pinned.gmail_account_id}; a send from ${insert.gmail_account_id} would ` +
              `put two different senders in one thread`
          )
        }

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

    /** The real `!inner` join on `sends.gmail_account_id`. */
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

    loadSequence: async (leadId: string) =>
      DEFAULT_SEQUENCE.map((step) => ({
        id: `step-${leadId}-${step.position}`,
        leadId,
        position: step.position,
        kind: step.kind,
        name: step.kind === "email" ? `Email ${step.position}` : "Wait",
        subject: step.subject ?? "",
        bodyHtml: step.bodyHtml ?? "",
        waitDays: step.waitDays,
      })),

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

// ── affinity: the rule that must never bend ───────────────────────────────────

test("each lead's whole sequence goes out from the mailbox that opened it", async () => {
  /*
   * The headline case. Two leads on two different accounts, both run to completion
   * through the real tick — and each recipient must see exactly one sender across
   * both of their emails.
   */
  reset()
  launch("ada", "acc-a")
  launch("bob", "acc-b")

  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "ada's opening email")
  assert.equal(deliveriesTo("bob@prospect.test").length, 1, "bob's opening email")

  makeFollowUpDue("ada")
  makeFollowUpDue("bob")
  await runTick()

  const ada = deliveriesTo("ada@prospect.test")
  const bob = deliveriesTo("bob@prospect.test")

  assert.equal(ada.length, 2, "ada: opening + follow-up")
  assert.equal(bob.length, 2, "bob: opening + follow-up")

  assert.deepEqual(
    ada.map((d) => d.from),
    ["a@gmail.com", "a@gmail.com"],
    "ada's whole sequence must come from the account that opened it"
  )
  assert.deepEqual(
    bob.map((d) => d.from),
    ["b@gmail.com", "b@gmail.com"],
    "bob's whole sequence must come from the account that opened it"
  )

  // And each follow-up threaded onto its own parent, not the other lead's.
  assert.equal(ada[1]!.threadId, ada[0]!.threadId ?? "thread-acc-a-1")
  assert.notEqual(ada[1]!.threadId, bob[1]!.threadId, "threads must not be shared")

  assertOneSenderPerRecipient("two leads, two accounts")
  assertNoDuplicates("two leads, two accounts")
})

test("the follow-up copies the parent's account, not the ticking one", async () => {
  /*
   * `enqueueNextStep` used to read `account.id` — the account whose tick was running.
   * Identical to the parent's today, but not the same *fact*, and this is the test
   * that would catch a regression to it: the lead sends from acc-b while acc-a ticks
   * first, so a tick-scoped read would stamp the follow-up with acc-a.
   */
  reset()
  launch("bob", "acc-b")

  await runTick()

  const followUp = world.rows.find((r) => r.lead_id === "lead-bob" && r.step_position === 2)
  assert.ok(followUp, "a follow-up must be queued")
  assert.equal(
    followUp.gmail_account_id,
    "acc-b",
    "the follow-up must inherit the parent's account, not whichever account ticked"
  )
  assertOneSenderPerRecipient("enqueue inherits the account")
})

test("a follow-up on the wrong account is refused, never sent as a new thread", async () => {
  /*
   * The last line of defence, forced. The parent row is rewritten to another account
   * behind the tick's back — which the real trigger would reject, so this is a state
   * only a bug could produce — and the follow-up must then fail rather than send.
   *
   * Sending it is the unrecoverable outcome: it would arrive from b@ inside a thread
   * a@ started, quoting a@'s subject. Failing is recoverable.
   */
  reset()
  launch("ada", "acc-a")
  await runTick()
  assert.equal(deliveriesTo("ada@prospect.test").length, 1)

  const parent = world.rows.find((r) => r.lead_id === "lead-ada" && r.step_position === 0)!
  parent.gmail_account_id = "acc-b"

  const followUp = makeFollowUpDue("ada")

  // Several ticks: a retry must not eventually get it out, either.
  for (let i = 0; i < 4; i += 1) await runTick()

  assert.equal(
    deliveriesTo("ada@prospect.test").length,
    1,
    "the mismatched follow-up must never be delivered"
  )
  assert.equal(
    world.rows.find((r) => r.id === followUp.id)!.status,
    "failed",
    "it must be failed permanently, not left pending to be retried forever"
  )
  assertOneSenderPerRecipient("wrong-account follow-up refused")
})

test("a wrong-account follow-up fails on its first attempt, not after five", async () => {
  /*
   * `WrongAccountError` is routed to `markPermanentlyFailed`, so `attempt_count` must
   * not climb: retrying cannot reassign the row, and five attempts would just be five
   * chances to get the account right by accident.
   */
  reset()
  launch("ada", "acc-a")
  await runTick()

  world.rows.find((r) => r.lead_id === "lead-ada" && r.step_position === 0)!.gmail_account_id =
    "acc-b"
  const followUp = makeFollowUpDue("ada")

  await runTick()

  const row = world.rows.find((r) => r.id === followUp.id)!
  assert.equal(row.status, "failed")
  assert.equal(row.attempt_count, 1, "one attempt, then permanent — not a retry loop")
  assertOneSenderPerRecipient("permanent on first attempt")
})

test("the enqueue itself refuses to write a cross-account follow-up", async () => {
  /*
   * The database trigger, modelled in the queue mock. Even if `enqueueNextStep` were
   * changed to stamp the ticking account, the write would be rejected — so the bad
   * row cannot reach the table for a later tick to pick up.
   *
   * Driven directly rather than through the tick, because the tick is exactly what
   * must never produce this call.
   */
  reset()
  launch("ada", "acc-a")
  await runTick()

  const { sendQueue } = await import("../src/scheduler/send-queue.ts")

  await assert.rejects(
    () =>
      sendQueue.enqueue({
        lead_id: "lead-ada",
        step_position: 4,
        step_id: "step-x",
        is_follow_up: true,
        scheduled_at: new Date().toISOString(),
        user_id: USER_ID,
        gmail_account_id: "acc-b",
      } as never),
    /two different senders in one thread/,
    "a send naming another account for an already-pinned lead must be rejected"
  )
  assertOneSenderPerRecipient("enqueue rejects cross-account")
})

// ── isolation: one account's state is not another's ───────────────────────────

test("a capped account does not borrow another account's headroom", async () => {
  /*
   * acc-a is full; acc-b is idle. acc-a's backlog must wait for tomorrow rather than
   * leak onto acc-b — moving it would re-assign a lead that already has a thread.
   */
  reset([
    { id: "acc-a", email: "a@gmail.com", dailyLimit: 2, followUpSharePct: 50 },
    { id: "acc-b", email: "b@gmail.com", dailyLimit: 10, followUpSharePct: 50 },
  ])

  for (let i = 0; i < 5; i += 1) launch(`a${i}`, "acc-a")

  await runTick()

  assert.equal(sentFrom("acc-a").length, 2, "acc-a sends exactly its own cap")
  assert.equal(sentFrom("acc-b").length, 0, "acc-b must not send acc-a's leads")
  assert.equal(
    world.rows.filter((r) => r.status === "pending" && r.step_position === 0).length,
    3,
    "the rest stay queued on acc-a"
  )
  assertOneSenderPerRecipient("no cap borrowing")
  assertNoDuplicates("no cap borrowing")
})

test("each account's daily cap is counted separately", async () => {
  reset([
    { id: "acc-a", email: "a@gmail.com", dailyLimit: 3, followUpSharePct: 50 },
    { id: "acc-b", email: "b@gmail.com", dailyLimit: 2, followUpSharePct: 50 },
  ])

  for (let i = 0; i < 6; i += 1) launch(`a${i}`, "acc-a")
  for (let i = 0; i < 6; i += 1) launch(`b${i}`, "acc-b")

  for (let i = 0; i < 3; i += 1) await runTick()

  assert.equal(sentFrom("acc-a").length, 3, "acc-a: its own cap of 3, not the shared 5")
  assert.equal(sentFrom("acc-b").length, 2, "acc-b: its own cap of 2")
  assertOneSenderPerRecipient("separate caps")
  assertNoDuplicates("separate caps")
})

test("caps reset per account across an IST day boundary", async () => {
  reset([
    { id: "acc-a", email: "a@gmail.com", dailyLimit: 2, followUpSharePct: 50 },
    { id: "acc-b", email: "b@gmail.com", dailyLimit: 2, followUpSharePct: 50 },
  ])

  for (let i = 0; i < 3; i += 1) launch(`a${i}`, "acc-a")
  for (let i = 0; i < 3; i += 1) launch(`b${i}`, "acc-b")

  await runTick()
  assert.equal(world.deliveries.length, 4, "day 1: 2 + 2")

  nextDay()
  await runTick()

  assert.equal(world.deliveries.length, 6, "day 2: the remaining 1 + 1")
  assert.equal(sentFrom("acc-a").length, 3)
  assert.equal(sentFrom("acc-b").length, 3)
  assertOneSenderPerRecipient("cap reset")
  assertNoDuplicates("cap reset")
})

test("one account needing reauth does not stop the others sending", async () => {
  /*
   * The asymmetry that matters: an unhandled throw in the per-account loop would
   * abandon every account after it in the list, silently, every minute. acc-a is
   * listed first and is dead, so acc-b only sends if the failure is contained.
   */
  reset([
    { id: "acc-a", email: "a@gmail.com", dailyLimit: 10, followUpSharePct: 50, authFails: true },
    { id: "acc-b", email: "b@gmail.com", dailyLimit: 10, followUpSharePct: 50 },
  ])

  launch("ada", "acc-a")
  launch("bob", "acc-b")

  const result = await runTick()

  assert.equal(sentFrom("acc-b").length, 1, "the healthy account still sends")
  assert.equal(sentFrom("acc-a").length, 0, "the dead one sends nothing")
  assert.ok(
    result.skipped.some((s) => s.accountId === "acc-a" && s.reason === "needs_reauth"),
    `the dead account must be reported as skipped — got ${JSON.stringify(result.skipped)}`
  )

  // ada's row is untouched and still pinned, so reconnecting resumes it.
  const adaRow = world.rows.find((r) => r.lead_id === "lead-ada" && r.step_position === 0)!
  assert.equal(adaRow.status, "pending")
  assert.equal(adaRow.gmail_account_id, "acc-a", "the pin survives the outage")
  assertOneSenderPerRecipient("one account dead")
})

test("a lead pinned to a dead account is not rescued by a healthy one", async () => {
  /*
   * The tempting "fix" for the test above — let the working account pick up the
   * stranded lead — is exactly the thread break. Asserted explicitly so nobody adds
   * it as a feature.
   */
  reset([
    { id: "acc-a", email: "a@gmail.com", dailyLimit: 10, followUpSharePct: 50, authFails: true },
    { id: "acc-b", email: "b@gmail.com", dailyLimit: 10, followUpSharePct: 50 },
  ])

  launch("ada", "acc-a")
  await runTick()
  // ada's opening email went out from a@ before the account died.
  world.accounts[0]!.authFails = false
  await runTick()
  world.accounts[0]!.authFails = true

  makeFollowUpDue("ada")
  for (let i = 0; i < 3; i += 1) await runTick()

  const ada = deliveriesTo("ada@prospect.test")
  assert.deepEqual(
    ada.map((d) => d.from),
    ["a@gmail.com"],
    "the follow-up must wait for a@ to be reconnected, not go out from b@"
  )
  assertOneSenderPerRecipient("stranded lead not rescued")
})

test("a send failure on one account does not affect the other's leads", async () => {
  reset([
    {
      id: "acc-a",
      email: "a@gmail.com",
      dailyLimit: 10,
      followUpSharePct: 50,
      sendError: () => new Error("Gmail 500"),
    },
    { id: "acc-b", email: "b@gmail.com", dailyLimit: 10, followUpSharePct: 50 },
  ])

  launch("ada", "acc-a")
  launch("bob", "acc-b")

  await runTick()

  assert.equal(sentFrom("acc-b").length, 1, "acc-b is unaffected")
  assert.equal(sentFrom("acc-a").length, 0)
  assert.equal(
    world.rows.find((r) => r.lead_id === "lead-ada")!.status,
    "pending",
    "a transient failure is retried, not failed"
  )
  assertOneSenderPerRecipient("isolated send failure")
})

// ── replies: watchers are per mailbox ─────────────────────────────────────────

test("a reply watcher is only asked about threads in its own mailbox", async () => {
  /*
   * A watcher built from acc-a's credentials cannot read a thread in acc-b's mailbox
   * — it would 404 or, worse, return "no reply" and let a follow-up go out to someone
   * who already answered. So it must never be handed one.
   */
  reset()
  launch("ada", "acc-a")
  launch("bob", "acc-b")

  await runTick() // opening emails; leads become `sending`
  world.watcherCalls = []
  await runTick() // now the reply check runs over in-flight leads

  assert.ok(world.watcherCalls.length > 0, "the reply check must actually have run")

  for (const call of world.watcherCalls) {
    const row = world.rows.find((r) => r.gmail_thread_id === call.threadId)
    assert.ok(row, `unknown thread ${call.threadId}`)
    assert.equal(
      row.gmail_account_id,
      call.accountId,
      `account ${call.accountId} was asked about a thread owned by ${row.gmail_account_id}`
    )
  }
  assertOneSenderPerRecipient("watcher isolation")
})

test("a reply detected on one account stops only that lead's sequence", async () => {
  reset()
  launch("ada", "acc-a")
  launch("bob", "acc-b")

  await runTick()

  // ada replies in her own thread.
  const adaThread = world.rows.find(
    (r) => r.lead_id === "lead-ada" && r.gmail_thread_id !== null
  )!.gmail_thread_id!
  world.repliedThreads.set(adaThread, new Date())

  makeFollowUpDue("ada")
  makeFollowUpDue("bob")
  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1, "ada replied — no follow-up")
  assert.equal(deliveriesTo("bob@prospect.test").length, 2, "bob's sequence continues")
  assert.equal(world.leads.get("lead-ada")!.status, "replied")
  assertOneSenderPerRecipient("reply stops one lead")
  assertNoDuplicates("reply stops one lead")
})

// ── the budget split, per account ─────────────────────────────────────────────

test("the follow-up share is applied per account, and outreach keeps its floor", async () => {
  /*
   * The guarantee behind the Settings dialog: a follow-up backlog cannot consume the
   * whole day. acc-a has 4 follow-ups due and 4 new leads against a cap of 4 with a
   * 50% share, so it must send 2 and 2 rather than 4 follow-ups.
   */
  reset([{ id: "acc-a", email: "a@gmail.com", dailyLimit: 4, followUpSharePct: 50 }])

  // Four leads already mid-sequence, each with a due follow-up.
  for (let i = 0; i < 4; i += 1) {
    launch(`old${i}`, "acc-a")
  }
  await runTick() // their opening emails go out (cap 4, exactly 4)

  nextDay()
  for (let i = 0; i < 4; i += 1) makeFollowUpDue(`old${i}`)
  // ...and four brand-new leads competing for the same day.
  for (let i = 0; i < 4; i += 1) launch(`new${i}`, "acc-a")

  await runTick()

  const today = world.deliveries.filter((d) => d.position !== 0 || d.to.startsWith("new"))
  const followUps = today.filter((d) => d.position === 2).length
  const openings = today.filter((d) => d.position === 0).length

  assert.equal(followUps + openings, 4, "the cap is respected across both classes")
  assert.equal(followUps, 2, `follow-ups capped at their 50% share, got ${followUps}`)
  assert.equal(openings, 2, `new outreach keeps its floor, got ${openings}`)
  assertOneSenderPerRecipient("per-account split")
  assertNoDuplicates("per-account split")
})

test("follow-ups borrow unused outreach slots on the same account", async () => {
  reset([{ id: "acc-a", email: "a@gmail.com", dailyLimit: 4, followUpSharePct: 50 }])

  for (let i = 0; i < 4; i += 1) launch(`old${i}`, "acc-a")
  await runTick()

  nextDay()
  for (let i = 0; i < 4; i += 1) makeFollowUpDue(`old${i}`)
  // No new leads this time, so the outreach half goes unused.

  await runTick()

  const followUps = world.deliveries.filter((d) => d.position === 2).length
  assert.equal(followUps, 4, "with nothing new pending, follow-ups take the whole cap")
  assertOneSenderPerRecipient("borrowing")
  assertNoDuplicates("borrowing")
})

// ── scale and repetition ──────────────────────────────────────────────────────

test("50 leads across 2 accounts at 10/day: 3 days, no duplicates, one sender each", async () => {
  /*
   * The scenario end to end, run through the real tick. 25 leads per account, cap 10
   * — so 20 on day 1, 20 on day 2, 10 on day 3 — and every recipient sees exactly one
   * address throughout.
   */
  reset()

  for (let i = 0; i < 25; i += 1) launch(`a${i}`, "acc-a")
  for (let i = 0; i < 25; i += 1) launch(`b${i}`, "acc-b")

  await runTick()
  assert.equal(world.deliveries.length, 20, "day 1: 10 + 10")

  nextDay()
  await runTick()
  assert.equal(world.deliveries.length, 40, "day 2: another 10 + 10")

  nextDay()
  await runTick()
  assert.equal(world.deliveries.length, 50, "day 3: the last 5 + 5")

  assert.equal(sentFrom("acc-a").length, 25)
  assert.equal(sentFrom("acc-b").length, 25)

  // Every lead's opening email came from the account it was pinned to.
  for (const row of world.rows.filter((r) => r.step_position === 0)) {
    const lead = world.leads.get(row.lead_id)!
    const delivered = deliveriesTo(lead.email)
    assert.equal(delivered.length, 1, `${lead.email} must get exactly one opening email`)
    assert.equal(
      delivered[0]!.accountId,
      row.gmail_account_id,
      `${lead.email} was sent from the wrong account`
    )
  }

  assertOneSenderPerRecipient("50 leads")
  assertNoDuplicates("50 leads")
})

test("many ticks over many days never split a recipient across two senders", async () => {
  /*
   * The soak test. Full sequences for both accounts' leads run to completion over
   * repeated day boundaries, which is where a stale claim, a retry or a lazy enqueue
   * would have a chance to stamp the wrong account.
   */
  reset()

  for (let i = 0; i < 6; i += 1) launch(`a${i}`, "acc-a")
  for (let i = 0; i < 6; i += 1) launch(`b${i}`, "acc-b")

  for (let day = 0; day < 6; day += 1) {
    for (let tick = 0; tick < 3; tick += 1) await runTick()
    nextDay()
    // Waits elapse too, so queued follow-ups come due — the case where a lazy enqueue
    // or a retry gets its chance to stamp the wrong account.
    for (const row of world.rows) {
      if (row.status === "pending") row.scheduled_at = new Date(Date.now() - 60_000).toISOString()
    }
  }

  assert.equal(world.deliveries.length, 24, "12 leads × 2 emails each")

  for (const lead of world.leads.values()) {
    const sent = deliveriesTo(lead.email)
    assert.equal(sent.length, 2, `${lead.email} should get exactly 2 emails`)
    assert.equal(sent[0]!.from, sent[1]!.from, `${lead.email} was emailed by two addresses`)
  }

  assertOneSenderPerRecipient("soak")
  assertNoDuplicates("soak")
})

test("a crashed tick's claimed rows are recovered on the right account", async () => {
  /*
   * `releaseStaleClaims` runs once per tick, before the per-account loop, so it has to
   * hand rows back without disturbing their pin.
   */
  reset()
  launch("ada", "acc-a")
  launch("bob", "acc-b")

  // Both rows stuck in `sending` by a crash 20 minutes ago.
  for (const row of world.rows) {
    row.status = "sending"
    row.claimed_at = new Date(Date.now() - 20 * 60_000).toISOString()
  }

  await runTick()

  assert.equal(deliveriesTo("ada@prospect.test").length, 1)
  assert.equal(deliveriesTo("bob@prospect.test").length, 1)
  assert.equal(deliveriesTo("ada@prospect.test")[0]!.from, "a@gmail.com")
  assert.equal(deliveriesTo("bob@prospect.test")[0]!.from, "b@gmail.com")
  assertOneSenderPerRecipient("stale claim recovery")
  assertNoDuplicates("stale claim recovery")
})

test("an excluded weekday postpones sends on every account alike", async () => {
  /*
   * Sending days are global, not per account. With today excluded, both accounts must
   * postpone rather than one of them squeezing through.
   */
  reset()
  const today = todayIST()
  world.outreachDays = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter((d) => d !== today)
  world.followUpDays = world.outreachDays

  launch("ada", "acc-a")
  launch("bob", "acc-b")

  const result = await runTick()

  assert.equal(world.deliveries.length, 0, "nothing sends on an excluded day")
  assert.equal(result.rescheduled, 2, "both are postponed")

  for (const row of world.rows) {
    assert.equal(row.status, "pending")
    assert.ok(
      Date.parse(row.scheduled_at) > Date.now(),
      "a postponed send must be dated in the future"
    )
  }
  assertOneSenderPerRecipient("excluded weekday")
})
