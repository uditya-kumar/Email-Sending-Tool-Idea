import { Router } from "express"
import { currentUser, requireUser } from "../auth/requireUser.ts"
import { findLead, loadSequence, setLeadStatus, type PositionedStep } from "../data/leads.ts"
import { loadSettings } from "../data/settings.ts"
import { listAccountsForUser } from "../email/accounts.ts"
import { AccountReauthRequiredError, ConflictError, NotFoundHttpError } from "../http/errors.ts"
import { route } from "../http/handler.ts"
import { idParamsSchema, launchSchema, type IdParams, type LaunchBody } from "../http/schemas.ts"
import { firstSendAt } from "../scheduler/schedule.ts"
import { sendQueue } from "../scheduler/send-queue.ts"
import { firstEmailStep } from "../../../shared/sequence.ts"
import { loggerFor } from "../logger.ts"
import type { GmailAccountRow } from "../db.ts"

/**
 * Launch and cancel, per recipient.
 *
 * Launching creates **one** `sends` row — the opening email — and nothing else.
 * The rest of the sequence is queued lazily as each step actually goes out
 * (`tick.ts`), so a wait is measured from the real send time and a follow-up the
 * user is still editing is not yet committed to.
 *
 * The route's job is really validation: everything that would make the send fail
 * three days from now is checked here, while the user is still looking at the
 * screen and can fix it.
 */

const log = loggerFor("routes/leads")

export const leadsRouter = Router()

leadsRouter.use(requireUser)

leadsRouter.post(
  "/:id/launch",
  route<LaunchBody, IdParams>(
    { body: launchSchema, params: idParamsSchema },
    async ({ body, params, req }) => {
      const user = currentUser(req)

      const lead = await findLead(params.id, user.id)
      if (!lead) throw new NotFoundHttpError("That lead no longer exists.")

      if (lead.repliedAt) {
        throw new ConflictError(
          `${lead.email} has already replied — there's nothing left to send.`,
          "already_replied"
        )
      }
      if (lead.status === "scheduled" || lead.status === "sending") {
        throw new ConflictError(
          `${lead.email} is already in progress. Cancel it first to reschedule.`,
          "already_launched"
        )
      }

      const account = await pickAccount(user.id, body.gmailAccountId)
      const steps = await loadSequence(lead.id)
      const opening = requireOpeningEmail(steps)
      const settings = await loadSettings(user.id)

      const scheduledAt = firstSendAt(lead.sendTimeIST, settings.outreachDays)

      const send = await sendQueue.enqueue({
        user_id: user.id,
        lead_id: lead.id,
        step_id: opening.id,
        gmail_account_id: account.id,
        step_position: opening.position,
        is_follow_up: false,
        status: "pending",
        scheduled_at: scheduledAt.toISOString(),
      })

      /*
       * `enqueue` is idempotent on `(lead_id, step_position)`, so a null means a
       * row for this step already exists — a double-clicked Launch, or a relaunch
       * after a previous attempt failed. Reporting the existing schedule is
       * correct; creating a second row would be a duplicate email.
       */
      if (!send) {
        const existing = (await sendQueue.listForLead(lead.id)).find(
          (row) => row.step_position === opening.position
        )

        return {
          leadId: lead.id,
          alreadyQueued: true,
          scheduledAt: existing?.scheduled_at ?? scheduledAt.toISOString(),
          status: existing?.status ?? "pending",
        }
      }

      await setLeadStatus(lead.id, "scheduled")

      log.info(
        { leadId: lead.id, at: scheduledAt.toISOString(), accountId: account.id },
        "Lead launched"
      )

      return {
        leadId: lead.id,
        alreadyQueued: false,
        // The real UTC instant, so the toast can show when it will actually go
        // out rather than echoing back the IST string the user typed.
        scheduledAt: scheduledAt.toISOString(),
        sendTimeIST: lead.sendTimeIST,
        from: account.email,
        status: "pending" as const,
      }
    }
  )
)

leadsRouter.post(
  "/:id/cancel",
  route<unknown, IdParams>({ params: idParamsSchema }, async ({ params, req }) => {
    const user = currentUser(req)

    const lead = await findLead(params.id, user.id)
    if (!lead) throw new NotFoundHttpError("That lead no longer exists.")

    const cancelled = await sendQueue.cancelPendingFor(lead.id)

    /*
     * Back to `draft` only if nothing has actually gone out. A lead whose opening
     * email is already in someone's inbox is not a draft, and showing it as one
     * would invite a relaunch that the idempotency index would then silently
     * refuse.
     */
    const sends = await sendQueue.listForLead(lead.id)
    const anySent = sends.some((send) => send.status === "sent")

    await setLeadStatus(lead.id, anySent ? "sent" : "draft")

    log.info({ leadId: lead.id, cancelled, anySent }, "Lead cancelled")

    return { leadId: lead.id, cancelled, status: anySent ? "sent" : "draft" }
  })
)

/** Where the lead's sequence stands — what the Database page's status column shows. */
leadsRouter.get(
  "/:id/sends",
  route<unknown, IdParams>({ params: idParamsSchema }, async ({ params, req }) => {
    const user = currentUser(req)

    const lead = await findLead(params.id, user.id)
    if (!lead) throw new NotFoundHttpError("That lead no longer exists.")

    const sends = await sendQueue.listForLead(lead.id)

    return {
      leadId: lead.id,
      sends: sends.map((send) => ({
        id: send.id,
        stepPosition: send.step_position,
        isFollowUp: send.is_follow_up,
        status: send.status,
        scheduledAt: send.scheduled_at,
        sentAt: send.sent_at,
        subject: send.subject_rendered,
        attemptCount: send.attempt_count,
        lastError: send.last_error,
      })),
    }
  })
)

/**
 * Which Gmail to send from.
 *
 * The account is pinned onto the `sends` row at launch rather than chosen at send
 * time, because a follow-up has to go out from the same mailbox that owns the
 * thread — Gmail's `threadId` is per-account and threading breaks otherwise.
 */
async function pickAccount(userId: string, requestedId?: string): Promise<GmailAccountRow> {
  const accounts = await listAccountsForUser(userId)

  if (accounts.length === 0) {
    throw new ConflictError("Connect a Gmail account in Settings first.", "no_account")
  }

  if (requestedId) {
    const requested = accounts.find((account) => account.id === requestedId)
    if (!requested) throw new NotFoundHttpError("That Gmail account isn't connected.")
    if (requested.status !== "active") throw new AccountReauthRequiredError()
    return requested
  }

  const active = accounts.filter((account) => account.status === "active")
  const [account, ...rest] = active

  if (!account) throw new AccountReauthRequiredError()

  if (rest.length > 0) {
    throw new ConflictError(
      "More than one Gmail account is connected — say which one to send from.",
      "ambiguous_account"
    )
  }

  return account
}

/**
 * The opening email, validated.
 *
 * Emptiness is checked here rather than trusted to the renderer three days later:
 * a scheduled send that fails at 09:30 on Thursday because the body was blank is
 * a silent loss, while a 409 at launch is a fixable message on screen. This is
 * also the reason the `template_steps`/`sequence_steps` tables allow empty bodies
 * at all — the frontend creates blank follow-ups.
 */
function requireOpeningEmail(steps: PositionedStep[]): PositionedStep {
  if (steps.length === 0) {
    throw new ConflictError("This recipient has no sequence yet.", "no_sequence")
  }

  const opening = firstEmailStep(steps)

  if (!opening) {
    throw new ConflictError(
      "This sequence has no email step — only waits.",
      "no_email_step"
    )
  }
  if (!opening.subject?.trim()) {
    throw new ConflictError("The opening email has no subject.", "empty_subject")
  }
  if (!hasVisibleText(opening.bodyHtml)) {
    throw new ConflictError("The opening email has an empty body.", "empty_body")
  }

  return opening
}

/**
 * Does this Tiptap HTML contain anything a reader would see?
 *
 * A body the user has clicked into but not typed in is `<p></p>` — non-empty as a
 * string, empty as an email. Tag-stripping is enough here; the renderer does the
 * same check properly with cheerio before sending.
 */
function hasVisibleText(html: string | undefined): boolean {
  if (!html) return false
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0
}
