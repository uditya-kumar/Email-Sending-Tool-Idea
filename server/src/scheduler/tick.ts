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
  type SendEmailResult,
} from "../email/gmail-mailer.ts"
import { attachmentStore } from "../storage/attachment-store.ts"
import {
  emailRenderer,
  EmptyStepError,
  type RenderedEmail,
} from "../render/email-renderer.ts"
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
  listAwaitingReplyForAccount,
  loadSequence,
  markLeadReplied,
  setLeadStatus,
  type PositionedStep,
} from "../data/leads.ts"
import { recordEvent } from "../data/events.ts"
import { nextEmailAfter } from "../../../shared/sequence.ts"
import { splitBudget } from "../../../shared/send-budget.ts"
import { sameAccountAsThread } from "../../../shared/assign-account.ts"
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
 *     The claim is split by class — follow-ups and new outreach each get a share of
 *     the cap, or the whole of it when the other has nothing waiting
 *     (`claimWithinShares`).
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

/**
 * A follow-up whose queued account is not the one that owns its thread.
 *
 * Its own class so `handleSendError` can fail it permanently: retrying cannot fix
 * it — the assignment is wrong, not the moment — and five attempts would just be
 * five chances to get the account right by accident.
 */
class WrongAccountError extends Error {
  override readonly name = "WrongAccountError"
}

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
      /*
       * One account's failure must not cost the others their tick. With a single
       * connected Gmail account this is nearly theoretical today, but the cost of
       * being wrong is asymmetric: an unhandled throw here abandons every account
       * after this one in the list, and it does so silently, every minute, forever.
       * `skipped` is the tick result's channel for exactly this.
       */
      try {
        await runForAccount(account, result)
      } catch (error) {
        log.error({ err: error, accountId: account.id }, "Account failed this tick")
        result.skipped.push({ accountId: account.id, reason: describe(error) })
      }
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
  const remaining = account.daily_limit - sentToday

  if (remaining <= 0) {
    log.info({ accountId: account.id, sentToday, limit: account.daily_limit }, "Daily cap reached")
    result.skipped.push({ accountId: account.id, reason: "daily cap reached" })
    return
  }

  // ── 4. Claim, each class within its own share ─────────────────────────────
  const claimed = await claimWithinShares(account, remaining)
  result.claimed += claimed.length

  if (claimed.length === 0) return

  log.info(
    { accountId: account.id, count: claimed.length, remaining },
    "Claimed due sends"
  )

  for (const [index, send] of claimed.entries()) {
    // ── 9. Jitter, between sends rather than before the first ──────────────
    if (index > 0) {
      await sleep(jitterMs(settings.jitterMinSeconds, settings.jitterMaxSeconds))
    }

    const outcome = await processSendSafely({ send, account, settings, mailer })

    if (outcome === "sent") result.sent += 1
    if (outcome === "failed") result.failed += 1
    if (outcome === "rescheduled") result.rescheduled += 1

    /*
     * A throttled account is throttled for every remaining message, so the batch
     * stops here rather than burning five attempts each on rows Gmail is going to
     * refuse anyway.
     *
     * The rows *after* this one have to be handed back explicitly. They were claimed
     * by `claimWithinShares` — `pending` → `sending`, atomically, before the first
     * send — and nothing in this branch has touched them: `markFailed` only ever sees
     * the one row that failed. Left as they were, they would sit in `sending`, which
     * matches no claim filter, until `releaseStaleClaims` freed them 15 minutes later.
     * Not a lost email, but 15 minutes of a queue that looks like it is working and
     * isn't, and a lead stuck on "sending" in the UI for the same 15 minutes.
     *
     * Safe to release precisely because none of them was attempted: the loop stops at
     * the first 429, so every row past `index` is untouched and unsent.
     */
    if (outcome === "rate-limited") {
      await releaseUnclaimed(claimed.slice(index + 1), "batch stopped: account is throttled")
      result.skipped.push({ accountId: account.id, reason: "rate limited, backing off" })
      return
    }
  }
}

/**
 * Hand back rows this tick claimed but never attempted.
 *
 * Each goes back to its own `scheduled_at` rather than a new time: it is still due
 * at the moment its recipient chose, and the next tick's stale-send grace window is
 * what decides whether that moment has passed.
 *
 * One failure per row, logged and swallowed. A row that cannot be released is one
 * `releaseStaleClaims` will pick up anyway, and this runs while an account is already
 * failing — the point is to leave the queue tidy, not to add a second way to throw.
 */
async function releaseUnclaimed(sends: SendRow[], reason: string): Promise<void> {
  for (const send of sends) {
    try {
      await sendQueue.reschedule(send.id, new Date(send.scheduled_at), reason)
    } catch (error) {
      log.warn({ err: error, sendId: send.id }, "Could not release an unattempted claim")
    }
  }
}

/**
 * Claim up to `remaining` due sends, giving follow-ups and new outreach each their
 * configured share of the day — and letting either take what the other doesn't use.
 *
 * Three claims rather than one. A single claim orders by `scheduled_at` across both
 * classes, so on a capped day the emails that go out are whichever happen to have
 * the earliest `send_time_ist`: 20 follow-ups and 10 new leads against a cap of 10
 * could resolve to 10/0, 0/10 or anything between, and it moves as send times are
 * edited. Follow-ups also arrive as a *backlog* while new leads trickle in, so
 * whichever side accumulates early-morning rows crowds the other out for days.
 *
 *  1. Follow-ups, up to their share of what is left of the day.
 *  2. Outreach, up to everything the first claim didn't take.
 *  3. Follow-ups again, for anything outreach left behind.
 *
 * Borrowing falls out of the ordering: each claim's ceiling is the previous claim's
 * *result*, so a class with nothing pending silently lends its whole share. That is
 * why this isn't computed up front from two counts — the claim is the only thing
 * that knows how many rows were really there, and counting first would leave a
 * window in which an overlapping tick or a detected reply changed the answer.
 *
 * Pass 3 exists because pass 1 is capped by the share, not by what is pending: with
 * a 40% follow-up share, 20 follow-ups and no new leads, pass 1 takes 4 and pass 2
 * takes 0 — the day would end 6 emails short of the cap without it.
 *
 * Follow-ups go first, and take the spare first, because one is threaded onto a
 * conversation the recipient is already in: a late follow-up is a visibly late
 * reply, while a cold email nobody is expecting can wait a day at no cost.
 */
async function claimWithinShares(
  account: GmailAccountRow,
  remaining: number
): Promise<SendRow[]> {
  /*
   * The share is a fraction of the *whole* day, so today's sends have to come off
   * the class allowance as well as off the total. Otherwise a 6/4 split sends six
   * follow-ups this morning and still offers a six-follow-up allowance this
   * afternoon — the ratio would hold per tick and drift over the day.
   */
  const followUpsSent = await sendQueue.sentToday(account.id, true)
  const dayShares = splitBudget(account.daily_limit, account.follow_up_share_pct)

  const followUpAllowance = Math.max(dayShares.followUps - followUpsSent, 0)

  // Never more than the whole day's remaining budget: the class allowance is a
  // share of the cap, not an addition to it.
  const followUps = await sendQueue.claimDue(
    account.id,
    Math.min(followUpAllowance, remaining),
    true
  )

  const outreach = await sendQueue.claimDue(account.id, remaining - followUps.length, false)

  const spare = remaining - followUps.length - outreach.length
  const borrowed = spare > 0 ? await sendQueue.claimDue(account.id, spare, true) : []

  log.info(
    {
      accountId: account.id,
      remaining,
      sharePct: account.follow_up_share_pct,
      followUps: followUps.length + borrowed.length,
      outreach: outreach.length,
      borrowedByFollowUps: borrowed.length,
    },
    "Split today's budget"
  )

  /*
   * Interleaved by due time, not concatenated. The three claims each come back
   * ordered but the batch is sent in array order, so concatenating would put every
   * follow-up ahead of every opening email regardless of the times their recipients
   * chose — a 16:00 follow-up would go out before a 09:00 first contact. Within one
   * tick the jitter between sends is the only spacing there is, so this ordering is
   * what the recipient actually experiences.
   */
  return [...followUps, ...outreach, ...borrowed].sort(
    (a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at)
  )
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

/**
 * `processSend`, but one send's unexpected failure can never take the queue with it.
 *
 * The outer wrapper exists because the interesting throws are the ones *outside*
 * `processSend`'s own try block — the weekday gate and the stale-send grace window,
 * which both call `rescheduleStaleAt`. That function raises `NoAllowedDayError` when
 * a day list is empty and `InvalidSendTimeError` on a malformed `send_time_ist`, and
 * both are reachable from ordinary data: the Settings day picker will happily let you
 * deselect every day (no CHECK constraint behind the column), and `send_time_ist` can
 * be edited outside the form.
 *
 * Unwrapped, either one escaped `runForAccount` into `runTick` and out to the cron
 * callback's `.catch()`. The consequences were out of all proportion to the cause:
 * the rest of the batch was abandoned, every *later account* was skipped, the claimed
 * row was left in `sending` until `releaseStaleClaims` freed it 15 minutes later —
 * and then the next tick hit the same lead and did it again. One bad row stopped the
 * entire queue indefinitely, and the only symptom was a single "Tick failed" log line
 * a minute. Silence is the worst failure mode this system has, because it looks
 * exactly like having nothing to send.
 *
 * So the row is failed rather than retried: nothing about it is transient, and
 * `last_error` puts the reason where the UI can show it instead of in a log nobody
 * is reading. The remaining sends then carry on.
 */
async function processSendSafely(context: ProcessSendContext): Promise<SendOutcome> {
  try {
    return await processSend(context)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(describe(error))

    log.error(
      { err: failure, sendId: context.send.id, leadId: context.send.lead_id },
      "Send could not be processed at all; failing it so the rest of the batch continues"
    )

    try {
      await sendQueue.markPermanentlyFailed(context.send.id, failure)
    } catch (writeError) {
      // Even the write failed (Supabase down mid-tick). Left in `sending` for
      // `releaseStaleClaims` to recover — but still not rethrown, because the other
      // sends in this batch are unaffected and deserve their chance to go out.
      log.error({ err: writeError, sendId: context.send.id }, "Could not fail the send either")
    }

    return "failed"
  }
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
  /*
   * Declared out here so step 7b can see them. The alternative — one try around
   * both the send and the bookkeeping — is the bug described below.
   */
  let result: SendEmailResult
  let rendered: RenderedEmail

  try {
    /*
     * Threading is resolved **before** rendering, not after, because it supplies
     * the subject a blank follow-up inherits. The other way round, `render` threw
     * `EmptyStepError` on the very follow-up the compose UI tells you to leave
     * blank ("leave it blank to send as a reply") — permanently failed, since an
     * empty step is deliberately not retryable. Found by sending a real one.
     */
    const threading = await threadingFor(send, lead)

    rendered = emailRenderer.render(step, lead, {
      trackOpens: settings.trackOpens,
      trackClicks: settings.trackClicks,
      trackingId: send.tracking_id,
      ...(threading.parentSubject ? { inheritedSubject: threading.parentSubject } : {}),
    })

    result = await mailer.send({
      to: lead.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(await attachmentsFor(step.id)),
      ...threading.headers,
    })
  } catch (error) {
    /*
     * The try ends at `mailer.send`, deliberately. Everything below it runs after
     * the email is in the recipient's inbox, and `handleSendError` has no branch
     * that can be right about a delivered message — see step 7b.
     */
    return handleSendError(error, context)
  }

  /*
   * ── 7b. Record the send, and never report a delivered email as failed ──────
   *
   * `markSent` was inside the try above, which made a database failure *after* a
   * successful delivery indistinguishable from the delivery having failed. The row
   * went back to `pending`, the next tick re-claimed it, and the same email went
   * out again — five times, until `MAX_ATTEMPTS`. Reproduced: one dropped
   * `markSent` write produced five identical emails.
   *
   * That is not an exotic failure. It is one statement over the network to
   * Supabase, on a 1 GB EC2 box, in a loop that runs every minute — a connection
   * reset there is ordinary, and the price of treating it as "not sent" is paid by
   * the prospect, in their inbox, five times.
   *
   * So the row is failed **permanently** instead. It is the deliberately wrong
   * status: the email did go out. But the only two options are a row that says
   * `failed` next to an email that was delivered, or a recipient who receives the
   * same cold email five times — and only one of those is recoverable. The lead
   * shows `failed` with the real reason in `last_error`, the send is *not*
   * re-attempted, and `gmail_thread_id` is logged here so the thread can still be
   * found by hand if the follow-up needs re-anchoring.
   */
  try {
    await sendQueue.markSent(send.id, result, rendered)
    log.info(
      { sendId: send.id, to: lead.email, threadId: result.threadId, position: step.position },
      "Email sent"
    )
  } catch (error) {
    log.error(
      {
        err: error,
        sendId: send.id,
        to: lead.email,
        gmailMessageId: result.gmailMessageId,
        threadId: result.threadId,
      },
      "Email WAS DELIVERED but could not be recorded; failing the row so it is never re-sent"
    )

    try {
      await sendQueue.markPermanentlyFailed(
        send.id,
        new Error(
          "The email was delivered, but recording it failed: " +
            `${describe(error)}. Gmail thread ${result.threadId}. ` +
            "Not retried — a retry would deliver a second copy."
        )
      )
    } catch (writeError) {
      /*
       * Supabase is unreachable for this row entirely. Left in `sending`, which is
       * the one status that stops it being re-claimed — and `releaseStaleClaims`
       * will unfortunately free it after 15 minutes. That residual risk is
       * accepted: it needs the database to be down for a quarter of an hour
       * *and* to come back, and there is nothing left to write the truth with.
       */
      log.error(
        { err: writeError, sendId: send.id },
        "Could not fail the delivered send either; it may be re-sent once releaseStaleClaims frees it"
      )
    }

    // Not "sent": the row does not say sent, and the tick's counts should match
    // the database rather than what happened at Gmail.
    return "failed"
  }

  /*
   * ── 8. Next step, lazily ──────────────────────────────────────────────────
   *
   * **Outside the try, and this is load-bearing.** The email has left the building;
   * from here on nothing may route into `handleSendError`, because every path in it
   * treats the row as undelivered. `markFailed` would set a *sent* row back to
   * `pending`, the next tick would re-claim it, and it would be delivered again —
   * five times over, until `MAX_ATTEMPTS` finally failed a row whose email the
   * recipient had received five copies of.
   *
   * Not hypothetical: `enqueueNextStep` calls `followUpSendAt`, which throws
   * `NoAllowedDayError` when `follow_up_days` is empty — and the Settings day
   * picker lets you deselect every day, with no CHECK constraint behind it. One
   * click on the last enabled follow-up day turned every send that had a follow-up
   * behind it into five identical emails. Simulated in full before fixing.
   *
   * Swallowed rather than rethrown, for the same reason: a send that succeeded must
   * report "sent". A missing follow-up is recoverable — the sequence stalls, and
   * `enqueueNextStep` is idempotent through the `(lead_id, step_position)` unique
   * index, so a later successful tick picks it up. An extra email in a prospect's
   * inbox is not recoverable.
   */
  try {
    await enqueueNextStep({ send, lead, steps, settings, account })
  } catch (error) {
    log.error(
      { err: error, sendId: send.id, leadId: lead.id, position: send.step_position },
      "Email was sent, but queuing the next step failed; sequence stalled here"
    )
  }

  return "sent"
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

  /*
   * Wrong mailbox for this thread. Permanent for the same reason an empty step is:
   * no amount of waiting reassigns the row, and `last_error` puts the reason where
   * the UI shows it. Only this row is failed — the account is fine and its other
   * sends are unaffected, so the batch continues.
   */
  if (error instanceof WrongAccountError) {
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
 * The headers that keep a follow-up inside its thread, and the subject it inherits.
 *
 * All three of a matching `Subject`, `In-Reply-To`/`References` and `threadId` are
 * required; two out of three detaches the message in some clients. The parent's
 * **stored** subject is handed back verbatim rather than re-rendered, because a
 * lead edited since the opening email would otherwise produce a subtly different
 * subject and Gmail would start a new thread.
 *
 * `parentSubject` is only a *candidate*: the renderer prefers the step's own
 * subject when it has one. Returning it rather than deciding here keeps the
 * "which subject wins" rule in one place.
 */
async function threadingFor(
  send: SendRow,
  lead: Lead
): Promise<{
  parentSubject: string | null
  headers: Pick<SendEmailInput, "threadId" | "inReplyTo" | "references">
}> {
  if (!send.is_follow_up) return { parentSubject: null, headers: {} }

  const parent = await sendQueue.lastSentFor(lead.id)

  if (!parent?.gmail_thread_id) {
    log.warn(
      { sendId: send.id, leadId: lead.id },
      "Follow-up has no parent thread; sending as a new message"
    )
    return { parentSubject: null, headers: {} }
  }

  /*
   * The thread belongs to a different mailbox than the one about to send. Refused
   * outright — this is the one case that must not degrade to "send it as a new
   * message".
   *
   * Gmail's `threadId` is scoped to the account it was issued for, so the send
   * would not thread: the recipient would get a *second sender* appearing inside
   * their conversation, replying to a message that account never sent, quoting a
   * subject from another mailbox. That is indistinguishable from a thread-hijacking
   * phishing attempt, and the spam report it earns is the correct response to it.
   * Not sending is recoverable; sending that is not.
   *
   * Unreachable through the normal paths — the launch route pins the account and
   * `enqueueNextStep` copies it from the parent, with a database trigger
   * (`sends_lead_account_affinity`) behind both. It is checked anyway because this
   * is the last point at which the mismatch is still catchable, and one line here
   * is cheaper than the alternative being wrong.
   */
  if (!sameAccountAsThread(parent.gmail_account_id, send.gmail_account_id)) {
    throw new WrongAccountError(
      `This follow-up is queued on a different Gmail account than the one that owns ` +
        `the thread (${parent.gmail_account_id}). Not sending: it would appear as a ` +
        `second sender inside the recipient's existing conversation.`
    )
  }

  return {
    parentSubject: parent.subject_rendered,
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
    /*
     * **`send.gmail_account_id`, not `account.id`.** They are the same value today
     * — the row was claimed by this account — but they are not the same *fact*, and
     * the difference is the whole thread-affinity guarantee. This follow-up will be
     * threaded onto the message `send` just delivered, so it has to leave from the
     * mailbox that owns that thread. Copying it from the parent row states the rule
     * in the one place it has to hold, instead of relying on the claim and the
     * enqueue never drifting apart.
     */
    gmail_account_id: send.gmail_account_id,
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
  /*
   * Scoped to this account's own leads, not every in-flight lead.
   *
   * Unscoped, each account re-examined all N leads and skipped the ones belonging
   * to another mailbox — after a `lastSentFor` query each. With one account that is
   * exactly right and costs nothing; with three it is 3N queries to do N leads'
   * work, every minute, and the waste grows with the product of accounts and leads.
   * Filtering in the database also means an account with no leads of its own makes
   * no Gmail calls at all.
   */
  const leads = await listAwaitingReplyForAccount(account.id)
  if (leads.length === 0) return 0

  const watcher = replyWatcherFor(account)
  let detected = 0

  for (const lead of leads) {
    try {
      const parent = await sendQueue.lastSentFor(lead.id)

      // No thread yet means nothing has been delivered, so there is nothing to
      // reply to.
      if (!parent?.gmail_thread_id) continue
      /*
       * Kept despite the query above already filtering by account. That filter finds
       * leads with *any* send on this account; this checks the specific parent whose
       * thread is about to be read — and a Gmail thread id from another mailbox
       * resolves to nothing there, so a stray one would silently look like "no
       * reply" and let a follow-up go out after someone had already answered.
       */
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
