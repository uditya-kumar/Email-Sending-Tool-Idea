import { Router } from "express"
import { currentUser, requireUser } from "../auth/requireUser.ts"
import { findLead, findSequenceStep } from "../data/leads.ts"
import { findTemplateStep } from "../data/templates.ts"
import { listAccountsForUser, mailerFor } from "../email/accounts.ts"
import { AccountReauthRequiredError, ConflictError, NotFoundHttpError } from "../http/errors.ts"
import { route } from "../http/handler.ts"
import { testSendSchema, type TestSendBody } from "../http/schemas.ts"
import { emailRenderer } from "../render/email-renderer.ts"
import { attachmentStore } from "../storage/attachment-store.ts"
import { loggerFor } from "../logger.ts"
import type { GmailAccountRow } from "../db.ts"
import type { Lead, SequenceStep } from "../../../shared/types.ts"

/**
 * `POST /api/test-send` — send one step to one address, right now.
 *
 * Deliberately outside the scheduler: no `sends` row, no daily cap, no tracking
 * pixel and no click rewriting. A test must not appear in the recipient's
 * engagement history or consume the day's budget, and it must not create a queue
 * row that a later launch would then collide with.
 *
 * It is also the most security-sensitive endpoint in the app — it sends real mail
 * from the owner's own Gmail using a browser-supplied payload — which is why
 * every id is re-resolved server-side with an explicit ownership filter rather
 * than trusted from the body.
 */

const log = loggerFor("routes/test-send")

export const testSendRouter = Router()

testSendRouter.use(requireUser)

testSendRouter.post(
  "/",
  route<TestSendBody>({ body: testSendSchema }, async ({ body, req }) => {
    const user = currentUser(req)

    const account = await soleAccount(user.id)
    const resolved = await resolveStep(body.stepId, user.id)
    const lead = await resolveLead(body.leadId, user.id, body.to)

    const rendered = emailRenderer.render(resolved.step, lead, {
      // Both off: a test send carries no tracking at all, which is also why no
      // trackingId is passed — there is no `sends` row for one to refer to.
      trackOpens: false,
      trackClicks: false,
    })

    const attachments =
      resolved.source === "sequence"
        ? await attachmentStore.fetchForStep(body.stepId)
        : await attachmentStore.fetchForTemplateStep(body.stepId)
    const mailer = mailerFor(account)

    // No try/catch: `errorMiddleware` already maps GmailAuthError → 409
    // needs_reauth, GmailRateLimitError → 503, EmptyStepError → 409 empty_step.
    const result = await mailer.send({
      to: body.to,
      // Prefixed so a test can never be mistaken for the real thing in the
      // recipient's inbox — usually the owner's own.
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    })

    log.info({ to: body.to, stepId: body.stepId }, "Test email sent")

    return {
      sent: true,
      to: body.to,
      subject: rendered.subject,
      from: account.email,
      attachments: attachments.map((file) => file.filename),
      gmailMessageId: result.gmailMessageId,
    }
  })
)

/**
 * The one account to send from.
 *
 * Refuses rather than picking when there are several: a test that silently goes
 * out from the wrong address teaches the user the wrong thing about what a launch
 * will do.
 */
async function soleAccount(userId: string): Promise<GmailAccountRow> {
  const accounts = await listAccountsForUser(userId)

  if (accounts.length === 0) {
    throw new ConflictError(
      "Connect a Gmail account in Settings before sending.",
      "no_account"
    )
  }

  const active = accounts.filter((account) => account.status === "active")

  if (active.length === 0) {
    throw new AccountReauthRequiredError()
  }

  const [account, ...rest] = active

  if (!account) throw new AccountReauthRequiredError()

  if (rest.length > 0) {
    throw new ConflictError(
      "More than one Gmail account is connected; disconnect the ones you don't send from.",
      "ambiguous_account"
    )
  }

  return account
}

/**
 * A step id from the shared editor, which may belong to either table.
 *
 * Which table it was is returned alongside the step, not rediscovered later: the
 * attachment links live in two different tables keyed off the same id, so a
 * second lookup would be both a wasted round trip and a chance for the two
 * answers to disagree. `sequence_steps` is tried first because that is the
 * compose flow, where test sends mostly come from.
 */
async function resolveStep(
  stepId: string,
  userId: string
): Promise<{ step: SequenceStep; source: "sequence" | "template" }> {
  const sequenceStep = await findSequenceStep(stepId, userId)
  if (sequenceStep) return { step: sequenceStep, source: "sequence" }

  const templateStep = await findTemplateStep(stepId, userId)
  if (templateStep) return { step: templateStep, source: "template" }

  throw new NotFoundHttpError("That step no longer exists.")
}

/**
 * Whose data to merge in.
 *
 * With no `leadId` — the Templates page, which has no recipient — a placeholder
 * lead is built whose fields are all empty. That is not a shortcut: empty values
 * make `renderTags` fall through to each tag's own fallback, which is exactly
 * what the Preview step shows, so the test email and the preview agree.
 */
async function resolveLead(
  leadId: string | undefined,
  userId: string,
  to: string
): Promise<Lead> {
  if (!leadId) return placeholderLead(to)

  const lead = await findLead(leadId, userId)
  if (!lead) throw new NotFoundHttpError("That lead no longer exists.")

  return lead
}

function placeholderLead(email: string): Lead {
  return {
    id: "test",
    companyName: "",
    firstName: "",
    lastName: "",
    email,
    personalizationLine: "",
    sendTimeIST: "10:00",
    verification: "not_verified",
    status: "draft",
  }
}

