import test from "node:test"
import assert from "node:assert/strict"
import {
  pickAccountForNewLead,
  sameAccountAsThread,
  type AccountLoad,
} from "../../shared/assign-account.ts"

/**
 * Distributing new leads across several connected mailboxes.
 *
 * Two separate concerns are asserted here, and only one of them is about balance.
 *
 * The balancing rule is a *preference*: a bad choice sends an email from a
 * mailbox that is closer to its cap than it needed to be, which costs a
 * postponement at worst. Those tests describe intent.
 *
 * `sameAccountAsThread` is an *invariant*: a bad answer there delivers a
 * follow-up from a second address into an existing conversation, which is
 * unrecoverable — the email is in someone's inbox — and reads to the recipient as
 * a hijacked thread. It is also enforced twice more, in `threadingFor` and in the
 * `sends_lead_account_affinity` trigger, because that is the cost of being wrong.
 */

function account(over: Partial<AccountLoad> & { id: string }): AccountLoad {
  return {
    email: `${over.id}@example.com`,
    dailyLimit: 20,
    sentToday: 0,
    activeLeads: 0,
    ...over,
  }
}

test("pickAccountForNewLead: an empty list is null, not a throw", () => {
  // The caller distinguishes "none connected" from "all need re-auth" and has the
  // context to say which; this cannot.
  assert.equal(pickAccountForNewLead([]), null)
})

test("pickAccountForNewLead: one account is chosen regardless of how full it is", () => {
  // Not a capacity check. The daily cap is enforced at send time by the tick,
  // which postpones rather than dropping — refusing to assign here would instead
  // leave the lead unlaunchable.
  const only = account({ id: "a", dailyLimit: 5, sentToday: 5 })
  assert.equal(pickAccountForNewLead([only])?.id, "a")
})

test("pickAccountForNewLead: prefers proportional headroom over the raw remainder", () => {
  /*
   * The case round-robin and remainder-counting both get wrong. `big` has more
   * slots left in absolute terms (45 vs 4) but has already spent 10% of its day,
   * while `small` is untouched. Proportional headroom picks the untouched one.
   */
  const big = account({ id: "big", dailyLimit: 50, sentToday: 5 })
  const small = account({ id: "small", dailyLimit: 5, sentToday: 1 })
  const fresh = account({ id: "fresh", dailyLimit: 5, sentToday: 0 })

  assert.equal(pickAccountForNewLead([big, small, fresh])?.id, "fresh")
})

test("pickAccountForNewLead: a nearly-exhausted big account loses to a small idle one", () => {
  const nearlyDone = account({ id: "warm", dailyLimit: 50, sentToday: 48 })
  const idle = account({ id: "cold", dailyLimit: 5, sentToday: 0 })

  assert.equal(pickAccountForNewLead([nearlyDone, idle])?.id, "cold")
})

test("pickAccountForNewLead: a batch launched before any send spreads across accounts", () => {
  /*
   * The reason `activeLeads` is in the rule at all, asserted as the behaviour it
   * exists for rather than as a comparator detail.
   *
   * Ten leads launched at 09:00 for a 15:00 send: nothing has gone out, so every
   * account reads 0/limit all morning. Without the lead count as a tie-break, all
   * ten would pick the same mailbox — that account would then hit its cap at 15:00
   * and postpone the overflow to tomorrow while the others sat idle.
   *
   * Simulated the way the launch route actually behaves: assign, increment the
   * chosen account's in-flight count, assign again.
   */
  const accounts = [
    account({ id: "a", dailyLimit: 10 }),
    account({ id: "b", dailyLimit: 10 }),
    account({ id: "c", dailyLimit: 10 }),
  ]

  const assigned: string[] = []

  for (let i = 0; i < 9; i += 1) {
    const chosen = pickAccountForNewLead(accounts)
    assert.ok(chosen, "an account should always be chosen")
    assigned.push(chosen.id)
    // What `countActiveLeads` would report on the next launch.
    chosen.activeLeads += 1
  }

  const perAccount = accounts.map(
    (a) => assigned.filter((id) => id === a.id).length
  )

  assert.deepEqual(perAccount, [3, 3, 3], `uneven spread: ${assigned.join(",")}`)
})

test("pickAccountForNewLead: caps are respected in the spread, not just counts", () => {
  /*
   * Equal-count round-robin would be wrong here. `big` can absorb four times what
   * `small` can, so as leads are assigned the spread should follow the caps rather
   * than land 50/50 — proportional headroom is what makes that happen, since each
   * assignment raises the smaller account's load fraction four times as fast.
   */
  const big = account({ id: "big", dailyLimit: 40 })
  const small = account({ id: "small", dailyLimit: 10 })
  const accounts = [big, small]

  for (let i = 0; i < 20; i += 1) {
    const chosen = pickAccountForNewLead(accounts)
    assert.ok(chosen)
    // Stand in for the day progressing: assigned work eventually becomes sent work.
    chosen.sentToday += 1
  }

  assert.ok(
    big.sentToday > small.sentToday,
    `the larger cap should take more work, got big=${big.sentToday} small=${small.sentToday}`
  )
})

test("pickAccountForNewLead: the same inputs always give the same answer", () => {
  // Determinism matters because two concurrent launches read the same counts: an
  // arbitrary order would make the assignment depend on row order from Postgres.
  const accounts = [
    account({ id: "zzz" }),
    account({ id: "aaa" }),
    account({ id: "mmm" }),
  ]

  assert.equal(pickAccountForNewLead(accounts)?.id, "aaa")
  assert.equal(pickAccountForNewLead([...accounts].reverse())?.id, "aaa")
})

test("pickAccountForNewLead: a non-positive cap sorts last instead of dividing by zero", () => {
  /*
   * `daily_limit` has a `> 0` CHECK behind it, so this should be unreachable — but
   * `0 / 0` is NaN, and a comparator that returns NaN does not throw. It silently
   * produces an arbitrary order, which is exactly the failure the explicit branch
   * in `loadFactor` avoids.
   */
  const broken = account({ id: "broken", dailyLimit: 0 })
  const usable = account({ id: "usable", dailyLimit: 5, sentToday: 4 })

  assert.equal(pickAccountForNewLead([broken, usable])?.id, "usable")
  assert.equal(pickAccountForNewLead([usable, broken])?.id, "usable")
})

test("pickAccountForNewLead: never invents an account that wasn't offered", () => {
  // The returned object must be one of the candidates, not a copy or a default:
  // the caller sends from the id it gets back.
  const accounts = [account({ id: "a" }), account({ id: "b", sentToday: 1 })]
  const chosen = pickAccountForNewLead(accounts)

  assert.ok(accounts.some((a) => a === chosen), "returned an account not in the list")
})

test("sameAccountAsThread: only the owning mailbox may send into a thread", () => {
  /*
   * The invariant. A follow-up carries the parent's `threadId`,
   * `In-Reply-To`/`References` and subject — all of which are scoped to the account
   * that sent it. A mismatch does not fail loudly at Gmail; it starts a *new*
   * thread, so the recipient sees a second stranger replying inside their existing
   * conversation to a message that address never sent.
   */
  assert.equal(sameAccountAsThread("acct-1", "acct-1"), true)
  assert.equal(sameAccountAsThread("acct-1", "acct-2"), false)
})

test("sameAccountAsThread: no accidental looseness in the comparison", () => {
  /*
   * Guards the shape of the check rather than restating it. These are uuids from
   * two different columns, and the failure mode of a sloppy comparison here is a
   * delivered email — so a prefix, a case difference or a stray space must all
   * read as "different account".
   */
  assert.equal(sameAccountAsThread("acct-1", "acct-10"), false)
  assert.equal(sameAccountAsThread("acct-1", "ACCT-1"), false)
  assert.equal(sameAccountAsThread("acct-1", " acct-1"), false)
  assert.equal(sameAccountAsThread("", "acct-1"), false)
})
