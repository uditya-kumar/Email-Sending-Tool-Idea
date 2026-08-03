/**
 * How one day's send cap is divided between follow-ups and new outreach.
 *
 * **Shared, not server-only, for the same reason `schedule.ts` is.** The tick
 * divides the real budget; the Sender account card tells the user how it will be
 * divided. Those two answers have to agree, so they are one function rather than
 * one rule written twice — a copy in the browser would drift the first time the
 * rounding changed.
 *
 * ## Why a reserved share exists at all
 *
 * `claim_due_sends` orders by `scheduled_at`, so without a reserved share the two
 * classes compete on clock time alone: on a capped day the emails that go out are
 * whichever happen to have the earliest `send_time_ist`. With 20 follow-ups and 10
 * new leads due against a cap of 10 the outcome could be 10/0, 0/10 or anything
 * between, and it changes as send times are edited. Worse, it starves: follow-ups
 * accumulate as a backlog, so once a few early-morning leads pile up on one side
 * the other side can go days without sending.
 *
 * ## The share is a ceiling, never a floor
 *
 * A quota that couldn't be borrowed would waste the cap — a 60/40 split with no
 * follow-ups pending would send 4 emails on a 10-email day. So each class may take
 * the other's unused slots. With nothing on one side the other gets the whole day.
 *
 * That makes 0 and 100 both meaningful rather than degenerate: 0 is "follow-ups
 * only when there is no new outreach to send", 100 is "follow-ups first, always".
 *
 * Borrowing itself isn't computed here. `runForAccount` claims each class in turn
 * and lets the *result* of one claim set the ceiling for the next, because a claim
 * is the only thing that knows how many rows were really there — counting first and
 * claiming after would leave a window where another tick, or a reply, changed the
 * answer in between.
 */

/** A day's cap, and how much of it each class may use. */
export interface SendBudget {
  /** Emails still available today across both classes. */
  total: number
  /** Ceiling on follow-ups, before borrowing. */
  followUps: number
  /** Ceiling on opening emails, before borrowing. */
  outreach: number
}

/**
 * Split `total` remaining sends into the two ceilings.
 *
 * Follow-ups are rounded **down** so the reserved share can never exceed the
 * percentage asked for, and outreach takes the remainder — which keeps the two
 * summing to `total` exactly at every cap, including the odd ones a percentage
 * divides badly (7 at 50% is 3 + 4, not 4 + 4 or 3 + 3).
 *
 * Rounding down does mean a share too small to buy a whole email reserves nothing:
 * 20% of a 4-email cap is 0.8 → 0 follow-ups. Borrowing makes that harmless — with
 * no new outreach pending the follow-ups still get all four — and the alternative,
 * rounding up, would let a 1% share claim an email on every small cap, which reads
 * as the setting being ignored in the other direction.
 */
export function splitBudget(total: number, followUpSharePct: number): SendBudget {
  const capped = clampInt(total, 0, Number.MAX_SAFE_INTEGER)
  const pct = clampInt(followUpSharePct, 0, 100)

  const followUps = Math.floor((capped * pct) / 100)

  return { total: capped, followUps, outreach: capped - followUps }
}

/**
 * A whole number inside `[min, max]`, treating a non-finite input as `min`.
 *
 * The non-finite case is the reason this isn't written inline as
 * `Math.min(Math.max(Math.trunc(n), lo), hi)`: `Math.max(NaN, 0)` is **NaN**, so that
 * form reads as a clamp while clamping nothing, and every field of the returned budget
 * comes back NaN. Both inputs are `int` columns with CHECK constraints
 * (`daily_limit > 0`, `0 <= follow_up_share_pct <= 100`), so nothing in the database
 * can be NaN today — but this function is also called from the Settings dialog while a
 * number field is mid-edit, and it is what decides how much email may be sent.
 *
 * A NaN cap does fail safe rather than sending too much (`p_limit` serialises to JSON
 * null, `greatest(null, 0)` is 0, so `claim_due_sends` claims nothing) — but it fails
 * *silently*, and a queue that quietly sends zero looks exactly like a queue with
 * nothing to send. Clamping to `min` here means an unusable cap is 0 rather than NaN,
 * which is the same non-send with an honest number behind it.
 */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/**
 * The share to store so that `splitBudget(total, …)` reserves exactly
 * `followUps` — the inverse of the function above.
 *
 * Needed because the two representations serve different jobs. A percentage is what
 * survives a change to `daily_limit` (raising the cap 10 → 15 keeps the balance the
 * user chose), but nobody thinks in percentages when filling in a form: the dialog
 * asks for "how many of the 10". This converts at that boundary.
 *
 * Found by search rather than by arithmetic. `pct = round(followUps / total * 100)`
 * is not an inverse of a flooring split — 4 of 7 is 57%, and 57% of 7 floors back to
 * 3, so the dialog would silently save one fewer than it displayed. Trying each
 * percentage instead is correct by construction, and 101 iterations of integer
 * arithmetic is not worth being clever about.
 *
 * The **lowest** match is returned, of the run that all yield `followUps` (60–69 all
 * reserve 6 of 10). That is the one the user's own ratio names — 6 of 10 is 60%, not
 * 65% — so it is also the one that scales the way they'd predict when the cap moves.
 *
 * Not every count is representable: at 1% granularity a cap of 500 moves in steps of
 * 5, so "1 follow-up of 500" does not exist. Those fall back to the nearest
 * percentage, and the dialog shows the split it actually gets rather than the number
 * that was typed.
 */
export function sharePctFor(total: number, followUps: number): number {
  const capped = Math.max(Math.trunc(total), 0)
  const wanted = Math.min(Math.max(Math.trunc(followUps), 0), capped)

  for (let pct = 0; pct <= 100; pct++) {
    if (splitBudget(capped, pct).followUps === wanted) return pct
  }

  return capped > 0 ? Math.round((wanted * 100) / capped) : 0
}

/**
 * "6 follow-ups · 4 new" — the split as the Settings card states it.
 *
 * Describes the ceilings, not a prediction: what actually goes out depends on what
 * is pending, and borrowing can take either number up to the full cap. The card
 * says so in its own copy rather than trying to encode it here.
 */
export function describeSplit(dailyLimit: number, followUpSharePct: number): string {
  const { followUps, outreach } = splitBudget(dailyLimit, followUpSharePct)
  return `${followUps} follow-up${followUps === 1 ? "" : "s"} · ${outreach} new`
}
