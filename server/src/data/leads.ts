import { db, unwrap, unwrapMany, type LeadRow, type SequenceStepRow } from "../db.ts"
import { leadFromRow, stepFromRow } from "../../../shared/mappers.ts"
import type { Lead, SequenceStep } from "../../../shared/types.ts"

/**
 * Reads and status writes for `leads` + `sequence_steps`.
 *
 * Everything here returns the **domain** shape (`Lead`, `SequenceStep`) rather
 * than rows, because that is what the renderer and the shared sequence helpers
 * take. The row → domain conversion happens in `shared/mappers.ts` and nowhere
 * else, so a column rename surfaces there instead of inside a rendered email.
 */

/** A step with its `position`, which the domain `SequenceStep` deliberately omits. */
export interface PositionedStep extends SequenceStep {
  /** Order within the lead's sequence. The scheduler's cursor. */
  position: number
  /** Which lead's sequence this step belongs to. */
  leadId: string
}

function positionedFromRow(row: SequenceStepRow): PositionedStep {
  return { ...stepFromRow(row), position: row.position, leadId: row.lead_id }
}

export async function findLead(leadId: string, userId: string): Promise<Lead | null> {
  const row: LeadRow | null = await unwrap(
    "find lead",
    // user_id is explicit on every query in this file: the secret key bypasses
    // RLS, so this is the only thing scoping a route to its caller.
    db.from("leads").select("*").eq("id", leadId).eq("user_id", userId).maybeSingle()
  )

  return row ? leadFromRow(row) : null
}

/** A lead looked up by the scheduler, which acts for the row's own owner. */
export async function findLeadById(leadId: string): Promise<Lead | null> {
  const row: LeadRow | null = await unwrap(
    "find lead by id",
    db.from("leads").select("*").eq("id", leadId).maybeSingle()
  )

  return row ? leadFromRow(row) : null
}

/** A lead's whole sequence, ordered — what `nextEmailAfter` walks. */
export async function loadSequence(leadId: string): Promise<PositionedStep[]> {
  const rows = await unwrapMany(
    "load sequence steps",
    db
      .from("sequence_steps")
      .select("*")
      .eq("lead_id", leadId)
      .order("position", { ascending: true })
  )

  return rows.map(positionedFromRow)
}

/**
 * One step by id, whichever lead it belongs to, with the owner verified through
 * its parent lead.
 *
 * The join is how ownership is enforced: `sequence_steps` has no `user_id` of its
 * own (it inherits through `leads`), so without this the secret key would happily
 * return any user's step.
 */
export async function findSequenceStep(
  stepId: string,
  userId: string
): Promise<PositionedStep | null> {
  const row = await unwrap(
    "find sequence step",
    db
      .from("sequence_steps")
      .select("*, leads!inner(user_id)")
      .eq("id", stepId)
      .eq("leads.user_id", userId)
      .maybeSingle()
  )

  if (!row) return null

  // The embedded `leads` object was only there for the ownership filter; strip it
  // so the value still matches the plain row shape the mapper expects.
  const { leads: _leads, ...step } = row
  return positionedFromRow(step)
}

/** Set a lead's status, e.g. `draft` → `scheduled` at launch. */
export async function setLeadStatus(leadId: string, status: LeadRow["status"]): Promise<void> {
  await unwrap(
    "set lead status",
    db.from("leads").update({ status }).eq("id", leadId).select("id")
  )
}

/**
 * Mark a lead as replied.
 *
 * `replied_at` is what actually stops the sequence — `status` is for the UI — so
 * both are written in one update rather than risking a state where the badge says
 * "replied" while the scheduler still sees a live lead.
 */
export async function markLeadReplied(leadId: string, at: Date): Promise<void> {
  await unwrap(
    "mark lead replied",
    db
      .from("leads")
      .update({ replied_at: at.toISOString(), status: "replied" })
      .eq("id", leadId)
      .select("id")
  )
}

/**
 * Leads mid-sequence with no reply yet, whose sequence sends from one given
 * mailbox — the reply watcher's input.
 *
 * Scoped to an account rather than global, because a lead's thread lives in
 * exactly one mailbox and only that mailbox's credentials can read it. Unscoped,
 * every account walked every in-flight lead and discarded the ones it couldn't
 * see, at the cost of a `lastSentFor` query each, every minute.
 *
 * Expressed as an inner join on `sends` rather than a column on `leads`, because
 * the account is a property of the *send* — `leads` has no `gmail_account_id` and
 * adding one would be a denormalisation to keep in step by hand. `!inner` makes
 * PostgREST filter the outer rows by the embedded table instead of returning leads
 * with an empty `sends` array.
 *
 * A lead with several sends matches once per send, so the ids are de-duplicated
 * here. Doing it in SQL would need a `distinct` PostgREST can't express on an
 * embedded filter.
 */
export async function listAwaitingReplyForAccount(accountId: string): Promise<Lead[]> {
  const rows = await unwrapMany(
    "list leads awaiting reply for account",
    db
      .from("leads")
      .select("*, sends!inner(gmail_account_id)")
      .eq("status", "sending")
      .is("replied_at", null)
      .eq("sends.gmail_account_id", accountId)
  )

  const seen = new Set<string>()

  return rows
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .map(leadFromRow)
}
