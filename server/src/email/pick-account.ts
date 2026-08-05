import { listAccountsForUser } from "./accounts.ts"
import { sendQueue } from "../scheduler/send-queue.ts"
import {
  pickAccountForNewLead,
  type AccountLoad,
} from "../../../shared/assign-account.ts"
import {
  AccountReauthRequiredError,
  ConflictError,
  NotFoundHttpError,
} from "../http/errors.ts"
import { loggerFor } from "../logger.ts"
import type { GmailAccountRow } from "../db.ts"

/**
 * Choosing the mailbox a lead is launched from, when more than one Gmail is
 * connected.
 *
 * Split out of `routes/leads.ts` because it is no longer a two-line "the only
 * account" lookup: it reads per-account load, and a *relaunch* has to honour an
 * account this lead is already committed to rather than balancing afresh.
 *
 * The balancing rule itself is in `shared/assign-account.ts` — this module is only
 * the part that needs the database.
 */

const log = loggerFor("pick-account")

/**
 * Which Gmail to send a lead's **opening** email from.
 *
 * Resolution order, and each step matters:
 *
 *  1. **An account this lead already used.** A relaunch, or a launch of a lead
 *     whose earlier attempt failed, must reuse the mailbox that owns the thread —
 *     otherwise the follow-ups reply into a conversation from a different sender.
 *     Checked before the explicit request, because being asked for the wrong one is
 *     not a reason to break a live thread.
 *  2. **An explicitly requested account**, validated to be the user's own and
 *     active.
 *  3. **The least-loaded active account**, by `shared/assign-account.ts`.
 */
export async function pickAccountForLead(
  userId: string,
  leadId: string,
  requestedId?: string
): Promise<GmailAccountRow> {
  const accounts = await listAccountsForUser(userId)

  if (accounts.length === 0) {
    throw new ConflictError("Connect a Gmail account in Settings first.", "no_account")
  }

  // ── 1. Already committed to a mailbox ───────────────────────────────────────
  const pinned = await pinnedAccountFor(leadId, accounts)

  if (pinned) {
    /*
     * Honoured even when `status !== 'active'`, and even when the request asked for
     * a different one. There is nothing else this lead *can* send from: its thread
     * lives in this mailbox. A reauth-needed account here is a "reconnect it"
     * problem, and saying so is more useful than silently sending the follow-up
     * from somewhere else.
     */
    if (pinned.status !== "active") {
      throw new AccountReauthRequiredError(
        `${pinned.email} already owns this recipient's thread but needs reconnecting ` +
          `before anything else can go out to them.`
      )
    }

    if (requestedId && requestedId !== pinned.id) {
      throw new ConflictError(
        `This recipient's thread is already with ${pinned.email}, so the rest of the ` +
          `sequence has to come from there too. Cancel and start over to move them.`,
        "account_pinned"
      )
    }

    return pinned
  }

  // ── 2. Explicitly requested ─────────────────────────────────────────────────
  if (requestedId) {
    const requested = accounts.find((account) => account.id === requestedId)

    if (!requested) throw new NotFoundHttpError("That Gmail account isn't connected.")
    if (requested.status !== "active") throw new AccountReauthRequiredError()

    return requested
  }

  // ── 3. Least loaded ─────────────────────────────────────────────────────────
  const active = accounts.filter((account) => account.status === "active")

  if (active.length === 0) throw new AccountReauthRequiredError()
  // Skip the load queries when there is nothing to choose between.
  if (active.length === 1 && active[0]) return active[0]

  const loads = await Promise.all(active.map(toAccountLoad))
  const chosen = pickAccountForNewLead(loads)

  // Unreachable — `active` is non-empty and `pickAccountForNewLead` only returns
  // null for an empty list — but this is the line that decides which mailbox real
  // email leaves from, so it says so rather than asserting with `!`.
  const account = chosen && active.find((candidate) => candidate.id === chosen.id)

  if (!account) throw new AccountReauthRequiredError()

  log.info(
    {
      leadId,
      chosen: account.email,
      among: loads.map((l) => `${l.email} ${l.sentToday}/${l.dailyLimit} (${l.activeLeads} leads)`),
    },
    "Assigned a sending account to a new lead"
  )

  return account
}

/**
 * The account a lead's existing sends are already tied to, if any.
 *
 * Reads every send rather than just the sent ones: a *pending* opening email has
 * already reserved a mailbox, and a relaunch that ignored it would leave the lead
 * with two rows naming two different accounts — which the
 * `sends_lead_account_affinity` trigger now rejects outright, but as a 500 from a
 * database error rather than something the UI can explain.
 *
 * An account id present on a send but missing from the user's list would mean a
 * disconnected mailbox; `null` then lets the caller assign a fresh one, which is
 * the only thing left to do.
 */
async function pinnedAccountFor(
  leadId: string,
  accounts: GmailAccountRow[]
): Promise<GmailAccountRow | null> {
  const sends = await sendQueue.listForLead(leadId)
  const existing = sends.find((send) => send.gmail_account_id)

  if (!existing) return null

  return accounts.find((account) => account.id === existing.gmail_account_id) ?? null
}

/** One account's current load — the input the balancing rule takes. */
async function toAccountLoad(account: GmailAccountRow): Promise<AccountLoad> {
  const [sentToday, activeLeads] = await Promise.all([
    sendQueue.sentToday(account.id),
    sendQueue.countActiveLeads(account.id),
  ])

  return {
    id: account.id,
    email: account.email,
    dailyLimit: account.daily_limit,
    sentToday,
    activeLeads,
  }
}
