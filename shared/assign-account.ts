/**
 * Which connected Gmail a **new** lead is launched from.
 *
 * Only ever consulted for an opening email. A follow-up inherits its parent's
 * account and never comes through here — see `sameAccountAsThread` below for why
 * that is not negotiable.
 *
 * Shared rather than server-only for the same reason `send-budget.ts` is: the
 * launch route picks the account and the compose screen tells the user which
 * mailbox their email will come from. Two implementations of "who's next" would
 * drift, and the one the user can see would be the wrong one.
 */

/** What the rule needs to know about one candidate mailbox. */
export interface AccountLoad {
  id: string
  email: string
  /** `gmail_accounts.daily_limit` — capacity, not a count. */
  dailyLimit: number
  /** Sends already made from this account in the current IST day. */
  sentToday: number
  /** Leads whose sequence is pinned to this account and still in flight. */
  activeLeads: number
}

/**
 * Pick the account a new lead should send from: the one with the most **headroom
 * left today**, measured as a fraction of its own cap.
 *
 * ## Why headroom and not round-robin
 *
 * Round-robin over a list assumes the accounts are interchangeable, and they are
 * not — each carries its own `daily_limit`, because a mailbox's safe volume
 * depends on its age and reputation. Alternating between a warmed-up account at
 * 50/day and a fresh one at 5/day would send the fresh one 50% of the traffic and
 * hit its cap by mid-morning, after which every remaining lead assigned to it
 * would be postponed to the next day. Distributing by *proportional* headroom
 * makes each account carry work in step with what it can actually absorb.
 *
 * `sentToday / dailyLimit` rather than the raw remainder for the same reason: 5
 * slots left out of 50 is a nearly-exhausted account, while 5 out of 5 is an
 * untouched one, and the raw number cannot tell them apart.
 *
 * ## Ties
 *
 * Two accounts equally loaded — the common case first thing in the morning, when
 * every one of them is at zero — are broken by `activeLeads`, then by id. The
 * first keeps a day's launches from all landing on whichever account the database
 * happened to return first: `sentToday` only moves once an email has actually
 * *gone out*, so ten leads launched at 09:00 for a 15:00 send would otherwise all
 * see 0/limit and all choose the same mailbox. Counting leads already assigned is
 * what makes the spread happen at launch time rather than at send time. Falling
 * back to the id keeps the choice deterministic, so the same inputs always give
 * the same answer.
 *
 * Returns `null` for an empty list — the caller decides whether that is "connect
 * an account" or "every account needs re-auth", and it has the context to say so.
 */
export function pickAccountForNewLead(accounts: AccountLoad[]): AccountLoad | null {
  if (accounts.length === 0) return null

  const ranked = [...accounts].sort((a, b) => {
    const byLoad = loadFactor(a) - loadFactor(b)
    if (byLoad !== 0) return byLoad

    const byLeads = a.activeLeads - b.activeLeads
    if (byLeads !== 0) return byLeads

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  return ranked[0] ?? null
}

/**
 * How full this account's day is, as `0`–`1`.
 *
 * A non-positive cap sorts last rather than dividing by zero. `daily_limit` has a
 * `> 0` CHECK behind it so that should be unreachable, but the alternative is
 * `Infinity` or `NaN` leaking into a comparator — and a comparator that returns
 * NaN doesn't throw, it silently produces an arbitrary order.
 */
function loadFactor(account: AccountLoad): number {
  if (account.dailyLimit <= 0) return Number.POSITIVE_INFINITY
  return account.sentToday / account.dailyLimit
}

/**
 * Does this account own the thread a follow-up is about to join?
 *
 * The guard behind the one rule that must never bend: **a lead's entire sequence
 * goes out from the mailbox that sent its opening email.**
 *
 * Gmail's `threadId` is scoped to the account it was issued for, so handing it to
 * a different mailbox does not thread the message — it starts a fresh
 * conversation, silently, while the code paths that set `In-Reply-To` and inherit
 * the parent's subject all still run as though threading had worked. The
 * recipient's view of that is worse than a missing follow-up: a second sender
 * appearing inside an existing conversation, replying to a message they never
 * received, quoting a subject from someone else's mailbox. It reads as a
 * compromised thread, and for a cold email it *is* what a phishing attempt looks
 * like — so the spam report it earns is entirely rational.
 *
 * Callers must skip the send rather than fall back to a new thread. There is no
 * good failure mode here, only a recoverable one (nothing sent, an error to look
 * at) and an unrecoverable one (the wrong thing delivered).
 */
export function sameAccountAsThread(
  parentAccountId: string,
  sendingAccountId: string
): boolean {
  return parentAccountId === sendingAccountId
}
