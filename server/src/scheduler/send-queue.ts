import {
  db,
  unwrap,
  unwrapMany,
  type SendInsert,
  type SendRow,
  type SendUpdate,
} from "../db.ts"
import { loggerFor } from "../logger.ts"
import type { SendEmailResult } from "../email/gmail-mailer.ts"

/**
 * The **only** module that writes to `sends`. Everything about the work queue —
 * claiming, retrying, giving up, enqueuing the next step — is expressed here as
 * named operations, so `tick.ts` never assembles an update object.
 *
 * Concentrating it matters because the queue's invariants are not local: a row
 * left in `sending` is stuck forever, and a row inserted twice for one step is a
 * duplicate email in someone's inbox.
 */

const log = loggerFor("send-queue")

/**
 * Backoff for a failed send: 2 minutes, 10 minutes, an hour, then give up.
 *
 * Short first, because the common failure is transient (a 500, a network blip)
 * and the recipient's slot has already passed. `attempt_count` is 1-based —
 * `claim_due_sends` increments it as part of the claim.
 */
const BACKOFF_MINUTES = [2, 10, 60] as const

/** After this many attempts a send is `failed` and stops consuming the daily cap. */
export const MAX_ATTEMPTS = 5

export class SendQueue {
  /**
   * Atomically take up to `limit` due sends for one account.
   *
   * Delegates to the `claim_due_sends` RPC because `UPDATE … WHERE id IN (SELECT
   * … FOR UPDATE SKIP LOCKED) RETURNING *` cannot be expressed in supabase-js,
   * and that statement is the entire guarantee against double-sending: two
   * overlapping ticks, or a restart mid-loop, can never claim the same row.
   */
  async claimDue(accountId: string, limit: number): Promise<SendRow[]> {
    if (limit <= 0) return []

    const claimed = await unwrap(
      "claim due sends",
      db.rpc("claim_due_sends", { p_account_id: accountId, p_limit: limit })
    )

    return claimed ?? []
  }

  /** How many emails this account has sent today, in IST rather than UTC. */
  async sentToday(accountId: string): Promise<number> {
    const count = await unwrap(
      "count sends today",
      db.rpc("sent_today_count", { p_account_id: accountId })
    )

    return count ?? 0
  }

  /**
   * Record a successful send.
   *
   * All three Gmail identifiers are stored: the message id for Gmail API calls,
   * the thread id for `threadId` on the next follow-up, and the RFC Message-ID
   * for `In-Reply-To`/`References`. Threading needs the last two *and* a matching
   * subject, so dropping any of them silently detaches the follow-up.
   */
  async markSent(
    sendId: string,
    result: SendEmailResult,
    rendered: { subject: string; html: string }
  ): Promise<void> {
    await this.update(sendId, "mark send sent", {
      status: "sent",
      sent_at: new Date().toISOString(),
      gmail_message_id: result.gmailMessageId,
      gmail_thread_id: result.threadId,
      rfc822_message_id: result.rfcMessageId,
      // The audit trail: exactly what went out, which is also what proves the
      // preview and the delivered email agree.
      subject_rendered: rendered.subject,
      body_html_rendered: rendered.html,
      last_error: null,
    })
  }

  /**
   * Record a failure and decide whether to retry.
   *
   * Returns what it decided so the caller can log it, rather than the caller
   * recomputing the same condition and the two drifting apart.
   */
  async markFailed(
    send: SendRow,
    error: Error
  ): Promise<{ retrying: true; nextAttemptAt: Date } | { retrying: false }> {
    const message = `${error.name}: ${error.message}`.slice(0, 2000)

    if (send.attempt_count >= MAX_ATTEMPTS) {
      await this.update(send.id, "mark send failed", {
        status: "failed",
        last_error: message,
      })
      log.error({ sendId: send.id, attempts: send.attempt_count }, "Send failed permanently")
      return { retrying: false }
    }

    // attempt_count is 1 after the first claim, so index 0 is the first retry.
    const minutes = BACKOFF_MINUTES[send.attempt_count - 1] ?? 60
    const nextAttemptAt = new Date(Date.now() + minutes * 60 * 1000)

    await this.update(send.id, "schedule send retry", {
      // Back to `pending`, never left in `sending`: a row stuck in `sending` is
      // invisible to every future claim and would never be retried at all.
      status: "pending",
      scheduled_at: nextAttemptAt.toISOString(),
      claimed_at: null,
      last_error: message,
    })

    log.warn({ sendId: send.id, minutes, err: error }, "Send failed, retrying")
    return { retrying: true, nextAttemptAt }
  }

  /**
   * Fail a send outright, with no retry.
   *
   * For failures that a retry cannot fix — an empty email body, a step that no
   * longer exists. Separate from `markFailed` so those cases don't have to fake an
   * attempt count to get past the backoff logic.
   */
  async markPermanentlyFailed(sendId: string, error: Error): Promise<void> {
    await this.update(sendId, "mark send permanently failed", {
      status: "failed",
      last_error: `${error.name}: ${error.message}`.slice(0, 2000),
    })

    log.error({ sendId, err: error }, "Send failed permanently (not retryable)")
  }

  /** Cancel one specific send, whatever state it is in. */
  async cancel(sendId: string, reason: string): Promise<void> {
    await this.update(sendId, "cancel send", { status: "cancelled", last_error: reason })
    log.info({ sendId, reason }, "Send cancelled")
  }

  /**
   * Push a send to a later time without counting it as an attempt.
   *
   * Used by the weekday gate and the stale-send grace window: neither is a
   * failure, so neither should consume a retry or record a `last_error`.
   */
  async reschedule(sendId: string, at: Date, reason: string): Promise<void> {
    await this.update(sendId, "reschedule send", {
      status: "pending",
      scheduled_at: at.toISOString(),
      claimed_at: null,
    })

    log.info({ sendId, at: at.toISOString(), reason }, "Send rescheduled")
  }

  /**
   * Queue the next email step in a lead's sequence.
   *
   * Called only **after** the previous step has actually gone out (lazy
   * creation), so a wait is measured from reality and a not-yet-sent step can
   * still be edited. Idempotent through the `(lead_id, step_position)` unique
   * index: an overlapping tick or a retried enqueue is a no-op rather than a
   * second email.
   *
   * Returns the created row, or `null` when one already existed.
   */
  async enqueue(insert: SendInsert): Promise<SendRow | null> {
    const rows = await unwrapMany(
      "enqueue send",
      db
        .from("sends")
        .upsert(insert, { onConflict: "lead_id,step_position", ignoreDuplicates: true })
        .select("*")
    )

    return rows[0] ?? null
  }

  /**
   * Stop every not-yet-sent email for a lead — a detected reply, or a manual
   * cancel from the UI.
   *
   * `sending` rows are deliberately left alone: one is in flight right now, and
   * cancelling it in the database would not unsend the email while making the row
   * disagree with the recipient's inbox.
   */
  async cancelPendingFor(leadId: string): Promise<number> {
    const cancelled = await unwrapMany(
      "cancel pending sends",
      db
        .from("sends")
        .update({ status: "cancelled" })
        .eq("lead_id", leadId)
        .eq("status", "pending")
        .select("id")
    )

    if (cancelled.length > 0) {
      log.info({ leadId, count: cancelled.length }, "Cancelled pending sends")
    }

    return cancelled.length
  }

  /** The most recent sent email for a lead — the parent a follow-up threads onto. */
  async lastSentFor(leadId: string): Promise<SendRow | null> {
    return unwrap(
      "find last sent send",
      db
        .from("sends")
        .select("*")
        .eq("lead_id", leadId)
        .eq("status", "sent")
        .order("step_position", { ascending: false })
        .limit(1)
        .maybeSingle()
    )
  }

  /** Every send for a lead, newest first — what the launch route reports back. */
  async listForLead(leadId: string): Promise<SendRow[]> {
    return unwrapMany(
      "list sends for lead",
      db
        .from("sends")
        .select("*")
        .eq("lead_id", leadId)
        .order("step_position", { ascending: true })
    )
  }

  /** A send by its public tracking id — the pixel and click endpoints' only lookup. */
  async findByTrackingId(trackingId: string): Promise<SendRow | null> {
    return unwrap(
      "find send by tracking id",
      db.from("sends").select("*").eq("tracking_id", trackingId).maybeSingle()
    )
  }

  /**
   * Release rows a crash left in `sending`.
   *
   * Without this a kill -9 between the claim and the send leaks the row forever:
   * `sending` matches no claim filter, so nothing ever looks at it again. Run at
   * boot, and bounded by `claimed_at` so a send in flight in *this* process is
   * never yanked out from under itself.
   */
  async releaseStaleClaims(olderThanMinutes = 15): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()

    const released = await unwrapMany(
      "release stale claims",
      db
        .from("sends")
        .update({ status: "pending", claimed_at: null })
        .eq("status", "sending")
        .lt("claimed_at", cutoff)
        .select("id")
    )

    if (released.length > 0) {
      log.warn({ count: released.length }, "Released sends stuck in 'sending'")
    }

    return released.length
  }

  private async update(sendId: string, operation: string, patch: SendUpdate): Promise<void> {
    await unwrap(operation, db.from("sends").update(patch).eq("id", sendId).select("id"))
  }
}

export const sendQueue = new SendQueue()
