import test from "node:test"
import assert from "node:assert/strict"
import { describeSplit, sharePctFor, splitBudget } from "../../shared/send-budget.ts"

/**
 * The daily cap and how it is divided.
 *
 * The cap is a deliverability control, not a preference: Gmail's limits degrade an
 * account long before the hard ~500/day, and a cold-outreach domain that sends 30 on
 * a 15 cap gets its reputation hit rather than an error. So the properties asserted
 * here are conservation ones — the two ceilings sum to the cap exactly, at every cap,
 * for every percentage — and they are checked exhaustively rather than by example.
 *
 * `splitBudget` is also called from two places that must not disagree: the tick
 * divides the real budget, and the Sender account card tells the user how it will be
 * divided. A drift between them is a UI that lies about what will be sent.
 */

test("splitBudget: the two ceilings always sum to the cap, for every cap and share", () => {
  /*
   * The conservation property, over every cap 0–100 × every percentage 0–100.
   * Rounding is where a split silently gains or loses an email: floor on both sides
   * loses one at odd caps, round on both gains one. Overshooting the cap is the
   * dangerous direction — it sends more email than the user authorised.
   */
  for (let total = 0; total <= 100; total += 1) {
    for (let pct = 0; pct <= 100; pct += 1) {
      const { followUps, outreach } = splitBudget(total, pct)

      assert.equal(followUps + outreach, total, `${total} @ ${pct}% did not sum to the cap`)
      assert.ok(followUps >= 0 && outreach >= 0, `${total} @ ${pct}% produced a negative ceiling`)
      assert.ok(followUps <= total, `${total} @ ${pct}% reserved more than the cap`)
    }
  }
})

test("splitBudget: the reserved share never exceeds the percentage asked for", () => {
  // Rounding down, asserted as the rule rather than as an example: rounding up would
  // let a 1% share claim a whole email on every small cap.
  for (let total = 1; total <= 60; total += 1) {
    for (let pct = 0; pct <= 100; pct += 1) {
      const { followUps } = splitBudget(total, pct)
      assert.ok(
        followUps <= (total * pct) / 100 + 1e-9,
        `${total} @ ${pct}% reserved ${followUps}, more than the share`
      )
    }
  }
})

test("splitBudget: 7 at 50% is 3 + 4 — an odd cap loses nothing", () => {
  assert.deepEqual(splitBudget(7, 50), { total: 7, followUps: 3, outreach: 4 })
})

test("splitBudget: 0 and 100 are meaningful, not degenerate", () => {
  // Both are real settings, because the share is a ceiling and either class can
  // borrow the other's unused slots: 0 is "follow-ups only when nothing new is
  // waiting", 100 is "follow-ups first, always".
  assert.deepEqual(splitBudget(10, 0), { total: 10, followUps: 0, outreach: 10 })
  assert.deepEqual(splitBudget(10, 100), { total: 10, followUps: 10, outreach: 0 })
})

test("splitBudget: nonsense inputs clamp rather than producing a bigger budget", () => {
  /*
   * `daily_limit` and `follow_up_share_pct` are columns; a hand-edited row can hold
   * anything. Every one of these must come back as a cap no larger than asked for —
   * a negative total that wrapped into a positive ceiling would send email the user
   * never authorised.
   */
  assert.deepEqual(splitBudget(-5, 50), { total: 0, followUps: 0, outreach: 0 })
  assert.deepEqual(splitBudget(10, -20), { total: 10, followUps: 0, outreach: 10 })
  assert.deepEqual(splitBudget(10, 500), { total: 10, followUps: 10, outreach: 0 })
  assert.deepEqual(splitBudget(10.9, 50), { total: 10, followUps: 5, outreach: 5 })
  assert.deepEqual(splitBudget(Number.NaN, 50), { total: 0, followUps: 0, outreach: 0 })
  assert.deepEqual(splitBudget(10, Number.NaN), { total: 10, followUps: 0, outreach: 10 })
})

test("sharePctFor: round-trips every count the dialog can offer", () => {
  /*
   * The dialog asks "how many of the 15?" and stores a percentage, so this has to be
   * a true inverse of the flooring split. The naive `round(n / total * 100)` is not:
   * 4 of 7 is 57%, and 57% of 7 floors back to 3 — the dialog would display 4 and
   * save 3, which is a send budget that silently disagrees with the screen.
   */
  for (let total = 1; total <= 50; total += 1) {
    for (let followUps = 0; followUps <= total; followUps += 1) {
      const pct = sharePctFor(total, followUps)
      const actual = splitBudget(total, pct).followUps

      // Not every count is representable at 1% granularity (a cap of 500 moves in
      // steps of 5), but every cap the UI allows is well under that.
      assert.equal(
        actual,
        followUps,
        `${followUps} of ${total} stored ${pct}% which reserves ${actual}`
      )
    }
  }
})

test("sharePctFor: returns the lowest percentage that yields the count", () => {
  // 60–69% all reserve 6 of 10; 60 is the one the user's own ratio names, and the
  // one that scales predictably when the cap moves.
  assert.equal(sharePctFor(10, 6), 60)
  assert.equal(sharePctFor(10, 0), 0)
  assert.equal(sharePctFor(10, 10), 100)
})

test("sharePctFor: clamps a count beyond the cap instead of over-reserving", () => {
  assert.equal(splitBudget(10, sharePctFor(10, 99)).followUps, 10)
  assert.equal(splitBudget(10, sharePctFor(10, -3)).followUps, 0)
})

test("describeSplit: the card's text is the split the tick will actually use", () => {
  // Same function behind both, so the string is derived rather than asserted
  // independently — the point is that the card cannot drift from the budget.
  assert.equal(describeSplit(15, 50), "7 follow-ups · 8 new")
  assert.equal(describeSplit(10, 60), "6 follow-ups · 4 new")
  assert.equal(describeSplit(2, 50), "1 follow-up · 1 new")
  assert.equal(describeSplit(1, 0), "0 follow-ups · 1 new")
})
