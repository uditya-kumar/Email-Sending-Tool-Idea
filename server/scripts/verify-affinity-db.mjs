/**
 * Live-database checks for the multi-account rules that unit tests **cannot** reach.
 *
 * `test/multi-account.test.ts` mocks `send-queue.ts` and `data/leads.ts` wholesale, so
 * two things that run in production go unexercised by it:
 *
 *  1. The `sends_lead_account_affinity` **trigger** — the last line of defence, and the
 *     only one that still holds if application code regresses.
 *  2. The real **PostgREST queries and RPCs**: `listAwaitingReplyForAccount`'s `!inner`
 *     join, `claim_due_sends`' per-account filter, `sent_today_count`'s scoping. A
 *     mutation test confirmed the unit suite stays green when the account scope is
 *     deleted from the reply query, because the mock stands in for it — so the query
 *     itself needs a database to be tested against.
 *
 * Everything goes through supabase-js, which is the same client and the same PostgREST
 * layer the server uses. A hand-written SQL probe would test Postgres but skip the
 * translation layer where `!inner` and `.eq("sends.gmail_account_id", …)` actually live.
 *
 * ## Safety
 *
 * The live database holds real leads and real send history. So:
 *
 *  - Every fixture row is tagged with `FIXTURE_TAG` in its email address, and cleanup
 *    only ever deletes rows matching that tag. No query here can touch a real lead.
 *  - Cleanup runs in a `finally`, and again on the way in, so a killed run self-heals.
 *  - Row counts are snapshotted before and after and compared, so "nothing persisted"
 *    is asserted rather than assumed.
 *  - Deletion order respects the FKs: sends → leads → account. `sends.gmail_account_id`
 *    is ON DELETE NO ACTION, so the account cannot go first.
 *
 * Run with:  node --env-file=.env scripts/verify-affinity-db.mjs
 */

import { createClient } from "@supabase/supabase-js"

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY

if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY are required (use --env-file=.env)")
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false } })

/** Every fixture row carries this, and cleanup matches on it alone. */
const FIXTURE_TAG = "affinity-probe-fixture"

let failures = 0
let checks = 0

function pass(message) {
  checks += 1
  console.log(`   ✓ ${message}`)
}

function fail(message) {
  checks += 1
  failures += 1
  console.log(`   ✗ ${message}`)
}

/** Assert a write was refused, and refused by the trigger rather than by luck. */
function expectRejected(label, error, expectedCode) {
  if (!error) {
    fail(`${label}: the write was ACCEPTED — it must be refused`)
    return
  }
  if (error.code !== expectedCode) {
    fail(`${label}: refused with ${error.code} (${error.message}), expected ${expectedCode}`)
    return
  }
  pass(`${label}: refused with ${expectedCode}`)
}

function expectAllowed(label, error) {
  if (error) {
    fail(`${label}: was BLOCKED (${error.code} ${error.message}) — it is legitimate`)
    return
  }
  pass(`${label}: allowed`)
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`)
}

async function snapshot() {
  const counts = {}

  for (const table of ["leads", "sends", "gmail_accounts", "events"]) {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true })
    if (error) throw new Error(`counting ${table}: ${error.message}`)
    counts[table] = count
  }

  return counts
}

/** Delete every fixture row, FK order first. Safe to call when there is nothing there. */
async function cleanup() {
  const { data: leads } = await db.from("leads").select("id").like("email", `%${FIXTURE_TAG}%`)

  for (const lead of leads ?? []) {
    // sends cascades from leads, but delete explicitly so a failure is visible here
    // rather than as a confusing FK error on the account.
    await db.from("sends").delete().eq("lead_id", lead.id)
    await db.from("leads").delete().eq("id", lead.id)
  }

  const { data: accounts } = await db
    .from("gmail_accounts")
    .select("id")
    .like("email", `%${FIXTURE_TAG}%`)

  for (const account of accounts ?? []) {
    await db.from("sends").delete().eq("gmail_account_id", account.id)
    await db.from("gmail_accounts").delete().eq("id", account.id)
  }
}

async function main() {
  console.log("Live-database affinity checks (PostgREST, the path the server uses).")

  // A killed previous run must not poison this one.
  await cleanup()
  const before = await snapshot()
  console.log(`   baseline: ${JSON.stringify(before)}`)

  const { data: settings, error: settingsError } = await db
    .from("settings")
    .select("user_id")
    .limit(1)
    .maybeSingle()

  if (settingsError || !settings) {
    throw new Error(`could not read a user to build fixtures for: ${settingsError?.message}`)
  }

  const userId = settings.user_id

  // Two throwaway accounts, so the real connected mailbox is never written to.
  const accountIds = []

  for (const suffix of ["one", "two"]) {
    const { data, error } = await db
      .from("gmail_accounts")
      .insert({
        user_id: userId,
        email: `${suffix}.${FIXTURE_TAG}@example.test`,
        display_name: "Affinity probe",
        google_sub: `${FIXTURE_TAG}-${suffix}`,
        refresh_token_enc: "not-a-real-token",
        scopes: [],
        status: "active",
        daily_limit: 10,
        follow_up_share_pct: 50,
      })
      .select("id")
      .single()

    if (error) throw new Error(`creating fixture account: ${error.message}`)
    accountIds.push(data.id)
  }

  const [acctA, acctB] = accountIds

  async function makeLead(name, status = "sending") {
    const { data, error } = await db
      .from("leads")
      .insert({
        user_id: userId,
        email: `${name}.${FIXTURE_TAG}@example.test`,
        send_time_ist: "09:30",
        status,
      })
      .select("id")
      .single()

    if (error) throw new Error(`creating fixture lead: ${error.message}`)
    return data.id
  }

  function sendRow(leadId, accountId, over = {}) {
    return {
      user_id: userId,
      lead_id: leadId,
      gmail_account_id: accountId,
      step_position: 0,
      is_follow_up: false,
      status: "pending",
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      ...over,
    }
  }

  // ── 1. The trigger ──────────────────────────────────────────────────────────
  section("Trigger: one lead, one mailbox")

  const leadOne = await makeLead("lead-one")

  const { data: opening, error: openingError } = await db
    .from("sends")
    .insert(sendRow(leadOne, acctA, { status: "sent", sent_at: new Date().toISOString() }))
    .select("id")
    .single()

  expectAllowed("opening email pins the lead to account A", openingError)

  const cross = await db
    .from("sends")
    .insert(sendRow(leadOne, acctB, { step_position: 2, is_follow_up: true }))
    .select("id")
  expectRejected("a follow-up on account B for the same lead", cross.error, "23514")

  const { error: sameError } = await db
    .from("sends")
    .insert(sendRow(leadOne, acctA, { step_position: 2, is_follow_up: true }))
    .select("id")
  expectAllowed("a follow-up on account A (the owner)", sameError)

  const moved = await db
    .from("sends")
    .update({ gmail_account_id: acctB })
    .eq("lead_id", leadOne)
    .eq("step_position", 2)
    .select("id")
  expectRejected("UPDATEing an existing send onto account B", moved.error, "23514")

  const { error: statusError } = await db
    .from("sends")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", opening?.id ?? "")
    .select("id")
  expectAllowed("an ordinary status update on a pinned send", statusError)

  const { error: rewriteError } = await db
    .from("sends")
    .update({ gmail_account_id: acctA })
    .eq("id", opening?.id ?? "")
    .select("id")
  expectAllowed("rewriting gmail_account_id to the SAME account", rewriteError)

  const leadTwo = await makeLead("lead-two")
  const { error: otherLeadError } = await db
    .from("sends")
    .insert(sendRow(leadTwo, acctB))
    .select("id")
  expectAllowed("a DIFFERENT lead using account B", otherLeadError)

  // ── 2. Per-account query scoping ────────────────────────────────────────────
  section("Queries: per-account scoping")

  /*
   * The reply-watcher query exactly as `listAwaitingReplyForAccount` issues it. A
   * watcher is built from one account's credentials and cannot read another mailbox's
   * thread, so being handed a foreign lead is the bug this guards.
   */
  const { data: awaitingA, error: awaitingError } = await db
    .from("leads")
    .select("id, email, sends!inner(gmail_account_id)")
    .eq("status", "sending")
    .is("replied_at", null)
    .eq("sends.gmail_account_id", acctA)
    .like("email", `%${FIXTURE_TAG}%`)

  if (awaitingError) {
    fail(`reply query errored: ${awaitingError.message}`)
  } else {
    const ids = [...new Set((awaitingA ?? []).map((row) => row.id))]
    if (ids.length === 1 && ids[0] === leadOne) {
      pass("reply query (!inner) returns only account A's lead")
    } else {
      fail(`reply query returned ${JSON.stringify(ids)}, expected just account A's lead`)
    }
  }

  // And the converse, so the check above isn't passing because the join found nothing.
  const { data: awaitingB } = await db
    .from("leads")
    .select("id, sends!inner(gmail_account_id)")
    .eq("status", "sending")
    .is("replied_at", null)
    .eq("sends.gmail_account_id", acctB)
    .like("email", `%${FIXTURE_TAG}%`)

  const bIds = [...new Set((awaitingB ?? []).map((row) => row.id))]
  if (bIds.length === 1 && bIds[0] === leadTwo) {
    pass("reply query for account B returns only its own lead")
  } else {
    fail(`account B's reply query returned ${JSON.stringify(bIds)}`)
  }

  /*
   * `claim_due_sends` must never hand one account another's rows. That filter is the
   * isolation guarantee — a capped account's backlog staying put depends on it.
   */
  const { data: claimedByB, error: claimBError } = await db.rpc("claim_due_sends", {
    p_account_id: acctB,
    p_limit: 100,
  })

  if (claimBError) {
    fail(`claim_due_sends(B) errored: ${claimBError.message}`)
  } else {
    const foreign = (claimedByB ?? []).filter((row) => row.lead_id === leadOne)
    if (foreign.length === 0) {
      pass("claim_due_sends(B) does not return account A's rows")
    } else {
      fail(`claim_due_sends(B) returned ${foreign.length} of account A's rows`)
    }
  }

  const { data: claimedByA, error: claimAError } = await db.rpc("claim_due_sends", {
    p_account_id: acctA,
    p_limit: 100,
  })

  if (claimAError) {
    fail(`claim_due_sends(A) errored: ${claimAError.message}`)
  } else {
    const own = (claimedByA ?? []).filter((row) => row.lead_id === leadOne)
    if (own.length >= 1) {
      pass(`claim_due_sends(A) finds its own ${own.length} row(s) — the filter isn't vacuous`)
    } else {
      fail("claim_due_sends(A) found none of its own rows; check 1 may be vacuous")
    }
  }

  const { data: sentA } = await db.rpc("sent_today_count", { p_account_id: acctA })
  const { data: sentB } = await db.rpc("sent_today_count", { p_account_id: acctB })

  if (sentA >= 1 && sentB === 0) {
    pass(`sent_today_count is per account (A=${sentA}, B=${sentB})`)
  } else {
    fail(`sent_today_count not scoped as expected: A=${sentA}, B=${sentB} (wanted A>=1, B=0)`)
  }

  // ── 3. Retire, not delete ───────────────────────────────────────────────────
  section("Foreign key: a used account is retired, not deleted")

  const del = await db.from("gmail_accounts").delete().eq("id", acctA).select("id")
  expectRejected("DELETE of an account that has sends", del.error, "23503")

  const { error: retireError } = await db
    .from("gmail_accounts")
    .update({ status: "revoked", refresh_token_enc: "", access_token_enc: null })
    .eq("id", acctA)
    .select("id")
  expectAllowed("retiring it instead (status=revoked, tokens cleared)", retireError)

  const { count: stillAttributed } = await db
    .from("sends")
    .select("*", { count: "exact", head: true })
    .eq("gmail_account_id", acctA)

  if (stillAttributed >= 1) {
    pass(`retiring keeps ${stillAttributed} send(s) attributed to it — history survives`)
  } else {
    fail("retiring lost the send attribution")
  }

  /*
   * The token columns must not be readable by the browser. The frontend reads the
   * `gmail_accounts_public` view, so verify it genuinely omits them — a view that
   * exposed them would leak refresh tokens under RLS.
   */
  const { data: publicRow, error: viewError } = await db
    .from("gmail_accounts_public")
    .select("*")
    .eq("id", acctA)
    .maybeSingle()

  if (viewError) {
    fail(`gmail_accounts_public errored: ${viewError.message}`)
  } else {
    const leaked = Object.keys(publicRow ?? {}).filter((column) => column.includes("token"))
    if (leaked.length === 0) {
      pass("gmail_accounts_public exposes no token columns")
    } else {
      fail(`gmail_accounts_public leaks ${leaked.join(", ")}`)
    }
  }

  return before
}

let before
try {
  before = await main()
} catch (error) {
  failures += 1
  console.error(`\nAborted: ${error.message}`)
} finally {
  await cleanup()
}

section("Nothing persisted")
if (before) {
  const after = await snapshot()
  const clean = JSON.stringify(before) === JSON.stringify(after)

  if (clean) {
    pass(`row counts unchanged: ${JSON.stringify(after)}`)
  } else {
    fail(`rows leaked — before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`)
  }
}

console.log(
  failures === 0
    ? `\nAll ${checks} database checks passed.\n`
    : `\n${failures} of ${checks} database checks FAILED.\n`
)

process.exit(failures === 0 ? 0 : 1)
