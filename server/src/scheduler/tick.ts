import { DateTime } from "luxon"
import {
  AccountNeedsReauthError,
  listActiveAccounts,
  mailerFor,
  markNeedsReauth,
  oauthClientFor,
  replyWatcherFor,
} from "../email/accounts.ts"
import {
  GmailAuthError,
  GmailRateLimitError,
  type GmailMailer,
  type SendEmailInput,
} from "../email/gmail-mailer.ts"
import { attachmentStore } from "../storage/attachment-store.ts"
import { emailRenderer, EmptyStepError } from "../render/email-renderer.ts"
import { sendQueue } from "./send-queue.ts"
import {
  daysFor,
  isAllowedDay,
  isStale,
  jitterMs,
  followUpSendAt,
  rescheduleStaleAt,
  sleep,
} from "./schedule.ts"
import { loadSettings } from "../data/settings.ts"
import {
  findLeadById,
  listAwaitingReply,
  loadSequence,
  markLeadReplied,
  setLeadStatus,
  type PositionedStep,
} from "../data/leads.ts"
import { recordEvent } from "../data/events.ts"
import { nextEmailAfter } from "../../../shared/sequence.ts"
import type { GmailAccountRow, SendRow } from "../db.ts"
import type { AllSettings, Lead } from "../../../shared/types.ts"
import { loggerFor } from "../logger.ts"

/**
 * The send loop, run once a minute by `node-cron` and also reachable as
 * `POST /api/cron/tick`.
 *
 * Ordering is the design, not an implementation detail:
 *
 *  1. **Tokens** — prove each account can still authenticate before doing work
 *     that would fail one email at a time.
 *  2. **Replies first.** A reply that arrived 40 seconds ago must cancel today's
 *     follow-up. Detecting after sending would be too late by exactly one email —
 *     the worst one to get wrong.
 *  3. **Cap**, then **claim**, so a claimed row is always inside the daily budget.
 *  4. Per send: weekday gate → stale-send grace → render → send → record →
 *     enqueue the next step lazily.
 *  5. **Jitter** between sends, because fifteen emails at exactly 09:30:00 is a
 *     machine signature.
 *
 * The whole loop is catch-up and idempotent: it claims every due row rather than
 * "this minute's", so a laptop closed for two days recovers on the next tick, and
 * `FOR UPDATE SKIP LOCKED` in the claim makes an overlapping tick harmless.
 */

const log = loggerFor("tick")

export interface TickResult {
  accounts: number
  claimed: number
  sent: number
  failed: number
  rescheduled: number
  repliesDetected: number
  /** Accounts skipped this tick, with why — the log line a stalled queue needs. */
  skipped: Array<{ accountId: string; reason: string }>
}

/**
 * Overlapping runs are prevented in-process as well as in the database.
 *
 * The atomic claim already makes a second concurrent tick *safe*; this only stops
 * it being wasteful. A tick with jitter can outlive its minute, and without the
 * guard `node-cron` would stack ticks that spend their time claiming zero rows.
 */
let running = false

export async function runTick(): Promise<TickResult> {
  const result: TickResult = {
    accounts: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    rescheduled: 0,
    repliesDetected: 0,
    skipped: [],
  }

  if (running) {
    log.debug("Previous tick still running; skipping this one")
    result.skipped.push({ accountId: "-", reason: "previous tick still running" })
    return result
  }

  running = true
  const startedAt = Date.now()

  try {
    // Recover anything a crash left mid-claim. A row stuck in `sending` matches
    // no future claim, so without this it would never be retried at all.
    await sendQueue.releaseStaleClaims()

    const accounts = await listActiveAccounts()
    result.accounts = accounts.length

    if (accounts.length === 0) {
      log.debug("No active Gmail accounts; nothing to do")
      return result
    }

    for (const account of accounts) {
      await runForAccount(account, result)
    }

    return result
  } finally {
    running = false
    log.info({ ...result, ms: Date.now() - startedAt }, "Tick finished")
  }
}

async function runForAccount(account: GmailAccountRow, result: TickResult): Promise<void> {
  const settings = await loadSettings(account.user_id)

  // ── 1. Tokens ────────────────────────────────────────────────────────────
  let mailer: GmailMailer
  try {
    mailer = await authorize(account)
  } catch (error) {
    if (error instanceof AccountNeedsReauthError || error instanceof GmailAuthError) {
      await markNeedsReauth(account.id, error.message)
      result.skipped.push({ accountId: account.id, reason: "needs_reauth" })
      return
    }
    throw error
  }

  // ── 2. Replies, before anything is sent ──────────────────────────────────
  result.repliesDetected += await detectReplies(account)

  // ── 3. Daily cap ─────────────────────────────────────────────────────────
  const sentToday = await sendQueue.sentToday(account.id)
  const budget = account.daily_limit - sentToday

  if (budget <= 0) {
    log.info({ accountId: account.id, sentToday, limit: account.daily_limit }, "Daily cap reached")
    result.skipped.push({ accountId: account.id, reason: "daily cap reached" })
    return
  }

  // ── 4. Claim ─────────────────────────────────────────────────────────────
  const claimed = await sendQueue.claimDue(account.id, budget)
  result.claimed += claimed.length

  if (claimed.length === 0) return

  log.info({ accountId: account.id, count: claimed.length, budget }, "Claimed due sends")

  for (const [index, send] of claimed.entries()) {
    // ── 9. Jitter, between sends rather than before the first ──────────────
    if (index > 0) {
      await sleep(jitterMs(settings.jitterMinSeconds, settings.jitterMaxSeconds))
    }

    const outcome = await processSend({ send, account, settings, mailer })

    if (outcome === "sent") result.sent += 1
    if (outcome === "failed") result.failed += 1
    if (outcome === "rescheduled") result.rescheduled += 1

    /*
     * A throttled account is throttled for every remaining message, so the rest
     * of the batch is released back to `pending` rather than burned through five
     * attempts each. They were already reset to pending by markFailed; stopping
     * here just avoids provoking Gmail further.
     */
    if (outcome === "rate-limited") {
      result.skipped.push({ accountId: account.id, reason: "rate limited, backing off" })
      return
    }
  }
}

/** Force a token refresh now, so a dead account is one log line, not N failures. */
async function authorize(account: GmailAccountRow): Promise<GmailMailer> {
  const client = oauthClientFor(account)

  try {
    // getAccessToken() refreshes when the cached token is expired or absent, and
    // it is the call that surfaces `invalid_grant` — including the 7-day expiry
    // that hits an OAuth consent screen left in Testing mode.
    await client.getAccessToken()
  } catch (error) {
    throw new GmailAuthError(
      `Could not refresh the access token for ${account.email}: ${describe(error)}`
    )
  }

  return mailerFor(account)
}

type SendOutcome = "sent" | "failed" | "rescheduled" | "skipped" | "rate-limited"

interface ProcessSendContext {
  send: SendRow
  account: GmailAccountRow
  settings: AllSettings
  mailer: GmailMailer
}

async function processSend(context: ProcessSendContext): Promise<SendOutcome> {
  const { send, account, settings, mailer } = context

  const lead = await findLeadById(send.lead_id)

  if (!lead) {
    // The FK cascades, so this is all but unreachable — but "all but" is why the
    // row is failed with a reason instead of left in `sending` forever.
    await sendQueue.markPermanentlyFailed(send.id, new Error("Lead no longer exists."))
    return "failed"
  }

  /*
   * A reply detected earlier in this very tick, or in the window between the
   * claim and now. Cancelled rather than rescheduled: the sequence is over, and a
   * rescheduled row would come back around and be skipped again every tick.
   */
  if (lead.repliedAt) {
    await sendQueue.cancel(send.id, "Lead replied before this email went out.")
    await sendQueue.cancelPendingFor(lead.id)
    log.info({ sendId: send.id, leadId: lead.id }, "Skipped send: lead already replied")
    return "skipped"
  }

  const allowedDays = daysFor(send.is_follow_up, settings)
  const scheduledAt = new Date(send.scheduled_at)

  // ── 5. Weekday gate ───────────────────────────────────────────────────────
  const now = DateTime.utc()

  if (!isAllowedDay(now.toJSDate(), allowedDays)) {
    await sendQueue.reschedule(
      send.id,
      rescheduleStaleAt(lead.sendTimeIST, allowedDays, now),
      "today is not an allowed sending day"
    )
    return "rescheduled"
  }

  // ── 6. Stale-send grace ───────────────────────────────────────────────────
  if (isStale(scheduledAt, settings.staleSendGraceHours)) {
    await sendQueue.reschedule(
      send.id,
      rescheduleStaleAt(lead.sendTimeIST, allowedDays, now),
      `more than ${settings.staleSendGraceHours}h late`
    )
    return "rescheduled"
  }

  const steps = await loadSequence(lead.id)
  const step = steps.find((candidate) => candidate.position === send.step_position)

  if (!step) {
    // Not retryable: the step was deleted, and no amount of waiting brings it
    // back. `markFailed` would otherwise burn five attempts on it.
    await sendQueue.markPermanentlyFailed(
      send.id,
      new Error(`Sequence step at position ${send.step_position} no longer exists.`)
    )
    return "failed"
  }

  // ── 7. Render and send ────────────────────────────────────────────────────
  try {
    const rendered = emailRenderer.render(step, lead, {
      trackOpens: settings.trackOpens,
      trackClicks: settings.trackClicks,
      trackingId: send.tracking_id,
    })

    const threading = await threadingFor(send, lead, rendered.subject)

    const result = await mailer.send({
      to: lead.email,
      subject: threading.subject,
      html: rendered.html,
      text: rendered.text,
      ...(await attachmentsFor(step.id)),
      ...threading.headers,
    })

    await sendQueue.markSent(send.id, result, rendered)
    log.info(
      { sendId: send.id, to: lead.email, threadId: result.threadId, position: step.position },
      "Email sent"
    )

    // ── 8. Next step, lazily ────────────────────────────────────────────────
    await enqueueNextStep({ send, lead, steps, settings, account })

    return "sent"
  } catch (error) {
    return handleSendError(error, context)
  }
}

async function handleSendError(error: unknown, context: ProcessSendContext): Promise<SendOutcome> {
  const { send, account } = context

  /*
   * An empty step is the one failure retrying cannot fix: the body is empty until
   * the user edits it, so it fails immediately rather than after five attempts.
   */
  if (error instanceof EmptyStepError) {
    await sendQueue.markPermanentlyFailed(send.id, error)
    return "failed"
  }

  if (error instanceof GmailAuthError) {
    // The account, not the message, is broken: release the row untouched so it
    // goes out unchanged once the user reconnects.
    await markNeedsReauth(account.id, error.message)
    await sendQueue.reschedule(send.id, new Date(send.scheduled_at), "account needs re-auth")
    return "rate-limited" // stops the rest of this account's batch
  }

  if (error instanceof GmailRateLimitError) {
    await sendQueue.markFailed(send, error)
    return "rate-limited"
  }

  const failure = error instanceof Error ? error : new Error(describe(error))
  const decision = await sendQueue.markFailed(send, failure)

  return decision.retrying ? "rescheduled" : "failed"
}

/**
 * The subject and headers that keep a follow-up inside its thread.
 *
 * All three of a matching `Subject`, `In-Reply-To`/`References` and `threadId` are
 * required; two out of three detaches the message in some clients. The parent's
 * **stored** subject is reused verbatim rather than re-rendered, because a lead
 * edited since the opening email would otherwise produce a subtly different
 * subject and Gmail would start a new thread.
 */
async function threadingFor(
  send: SendRow,
  lead: Lead,
  renderedSubject: string
): Promise<{
  subject: string
  headers: Pick<SendEmailInput, "threadId" | "inReplyTo" | "references">
}> {
  if (!send.is_follow_up) return { subject: renderedSubject, headers: {} }

  const parent = await sendQueue.lastSentFor(lead.id)

  if (!parent?.gmail_thread_id) {
    log.warn(
      { sendId: send.id, leadId: lead.id },
      "Follow-up has no parent thread; sending as a new message"
    )
    return { subject: renderedSubject, headers: {} }
  }

  return {
    subject: parent.subject_rendered ?? renderedSubject,
    headers: {
      threadId: parent.gmail_thread_id,
      ...(parent.rfc822_message_id
        ? {
            inReplyTo: parent.rfc822_message_id,
            references: [parent.rfc822_message_id],
          }
        : {}),
    },
  }
}

/** Attachments as a spreadable fragment, so an empty list omits the key entirely. */
async function attachmentsFor(stepId: string): Promise<Pick<SendEmailInput, "attachments">> {
  const attachments = await attachmentStore.fetchForStep(stepId)
  return attachments.length > 0 ? { attachments } : {}
}

interface EnqueueContext {
  send: SendRow
  lead: Lead
  steps: PositionedStep[]
  settings: AllSettings
  account: GmailAccountRow
}

/**
 * Queue follow-up N+1, now that N has actually gone out.
 *
 * Lazy on purpose (`BACKEND_PLAN.md` §8 step 8): creating the whole chain at
 * launch would fix every delay against a predicted send time and freeze steps the
 * user is still editing. Created one at a time, "wait 3 days" means three days
 * after the recipient really received the previous email.
 */
async function enqueueNextStep(context: EnqueueContext): Promise<void> {
  const { send, lead, steps, settings, account } = context

  const next = nextEmailAfter(steps, send.step_position)

  if (!next) {
    await setLeadStatus(lead.id, "sent")
    log.info({ leadId: lead.id }, "Sequence complete")
    return
  }

  // Mid-sequence: the UI shows "sending" until either the last step goes out or a
  // reply arrives.
  await setLeadStatus(lead.id, "sending")

  const scheduledAt = followUpSendAt(
    new Date(),
    next.waitDays,
    lead.sendTimeIST,
    settings.followUpDays
  )

  const created = await sendQueue.enqueue({
    user_id: account.user_id,
    lead_id: lead.id,
    step_id: next.step.id,
    gmail_account_id: account.id,
    step_position: next.step.position,
    is_follow_up: true,
    status: "pending",
    scheduled_at: scheduledAt.toISOString(),
  })

  if (created) {
    log.info(
      { leadId: lead.id, position: next.step.position, at: scheduledAt.toISOString() },
      "Follow-up queued"
    )
  }
}

/**
 * Check every in-flight lead's thread for an inbound message.
 *
 * A reply is the strongest possible stop signal, so it does three things at once:
 * flags the lead, records the event, and cancels the lead's pending sends.
 * Failures are logged per lead rather than thrown — one unreachable thread must
 * not stop the whole tick from sending.
 */
async function detectReplies(account: GmailAccountRow): Promise<number> {
  const leads = await listAwaitingReply()
  if (leads.length === 0) return 0

  const watcher = replyWatcherFor(account)
  let detected = 0

  for (const lead of leads) {
    try {
      const parent = await sendQueue.lastSentFor(lead.id)

      // No thread yet means nothing has been delivered, so there is nothing to
      // reply to.
      if (!parent?.gmail_thread_id) continue
      if (parent.gmail_account_id !== account.id) continue

      const check = await watcher.hasInboundReply(parent.gmail_thread_id)
      if (!check.replied) continue

      const at = check.at ?? new Date()

      await markLeadReplied(lead.id, at)
      await recordEvent({ sendId: parent.id, userId: account.user_id, type: "reply" })
      await sendQueue.cancelPendingFor(lead.id)

      detected += 1
      log.info({ leadId: lead.id, from: check.from }, "Reply detected; follow-ups cancelled")
    } catch (error) {
      if (error instanceof GmailAuthError) throw error
      log.warn({ err: error, leadId: lead.id }, "Reply check failed")
    }
  }

  return detected
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : JSON.stringify(error)
}
