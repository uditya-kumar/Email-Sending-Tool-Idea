import { stepFromRow, stepToColumns } from "@shared/mappers.ts"
import type { SequenceStep, StepAttachment } from "@shared/types.ts"
import {
  attachmentsOfSteps,
  deleteIfUnreferenced,
  fetchAttachmentsForSteps,
} from "./attachments"
import { supabase } from "./supabase"

/**
 * Persistence for `sequence_steps` — each lead's own copy of their sequence.
 *
 * Separate from `templates.ts` despite the identical columns, because the two have
 * different parents and different foreign keys pointing in. Three tables reference
 * these rows:
 *
 *  - `sends.step_id` — a queued or already-sent email references its step
 *  - `step_attachments.step_id` — cascades on delete
 *
 * A delete-then-insert would null out `sends.step_id` (it is `on delete set null`)
 * and silently drop every attachment of a scheduled email. So writes here
 * **preserve ids**, which the `(lead_id, position)` unique constraint allows
 * because it is `deferrable initially deferred`. `templates.ts` now does the same,
 * for the second of those reasons.
 *
 * `user_id` is never written — `sequence_steps` has no such column. RLS reaches it
 * through `leads`, so a step is only visible if its lead is.
 */

/**
 * A step whose id is a real `sequence_steps` UUID rather than a local placeholder.
 *
 * `shared/sequence.ts` generates ids like `email-<leadId>-2` for steps that exist
 * only on screen. Anything that resolves a step server-side — the test send, and
 * launch — needs the persisted id, so the two are worth telling apart by more than
 * convention.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isPersistedStepId(id: string): boolean {
  return UUID_PATTERN.test(id)
}

/**
 * Attach each email step's files to it.
 *
 * A second query rather than an embedded select, because PostgREST cannot express
 * "embed through a join table" here without also making the parent rows dependent
 * on it — and every email step needs an `attachments` array (empty or not) so the
 * UI can tell "none" from "not loaded yet".
 *
 * Delay steps are left with the property absent: they cannot carry a file, and an
 * empty array on them would imply the concept applies.
 */
async function withAttachments(steps: SequenceStep[]): Promise<SequenceStep[]> {
  const emailIds = steps.filter((s) => s.kind === "email").map((s) => s.id)
  const byStep = await fetchAttachmentsForSteps(emailIds)

  return steps.map((step) =>
    step.kind === "email" ? { ...step, attachments: byStep[step.id] ?? [] } : step
  )
}

/**
 * The files attached to the steps a write is about to delete — the lead's steps
 * whose ids are **not** in `keep`.
 *
 * Which steps those are has to be queried rather than inferred from the incoming
 * list: a step deleted on another tab, or one this list never knew about, is going
 * too. Pass an empty `keep` to mean "every step is going".
 */
async function attachmentsOfDeletedSteps(
  leadId: string,
  keep: string[]
): Promise<StepAttachment[]> {
  const query = supabase.from("sequence_steps").select("id").eq("lead_id", leadId)

  const { data, error } = await (keep.length > 0
    ? query.not("id", "in", `(${keep.join(",")})`)
    : query)

  if (error) throw new Error(error.message)

  return attachmentsOfSteps((data ?? []).map((row) => row.id))
}

/** One lead's steps, ordered, with their attachments. */
export async function fetchSequence(leadId: string): Promise<SequenceStep[]> {
  const { data, error } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("lead_id", leadId)
    .order("position", { ascending: true })

  if (error) throw new Error(error.message)

  return withAttachments((data ?? []).map((row) => stepFromRow(row)))
}

/**
 * Every lead's steps in one round trip, keyed by lead id.
 *
 * One query rather than one per lead: the Database page shows every recipient at
 * once, and N+1 requests over a few hundred leads is the difference between a page
 * that loads and one that doesn't. RLS already scopes this to the signed-in user,
 * so there is no filter to add.
 */
export async function fetchAllSequences(): Promise<Record<string, SequenceStep[]>> {
  const { data, error } = await supabase
    .from("sequence_steps")
    .select("*")
    .order("position", { ascending: true })

  if (error) throw new Error(error.message)

  const rows = data ?? []

  /*
   * One attachments query for every step of every lead, not one per lead — this is
   * the page-load read, and the whole reason `fetchAllSequences` exists is to avoid
   * N+1 over a few hundred recipients.
   */
  const byStep = await fetchAttachmentsForSteps(
    rows.filter((row) => row.kind === "email").map((row) => row.id)
  )

  const byLead: Record<string, SequenceStep[]> = {}

  for (const row of rows) {
    const steps = byLead[row.lead_id] ?? []
    steps.push(
      row.kind === "email"
        ? { ...stepFromRow(row), attachments: byStep[row.id] ?? [] }
        : stepFromRow(row)
    )
    byLead[row.lead_id] = steps
  }

  return byLead
}

/**
 * Write a lead's whole step list, keeping the ids of steps that already exist.
 *
 * Three statements, in this order, and the order is the design:
 *
 *  1. **Delete** the rows that are gone. First, because a step removed from the
 *     middle frees the position that a later step is about to move into — and a
 *     renumber onto a still-occupied position is a 23505 even with the constraint
 *     deferred, since PostgREST autocommits every statement separately (there is no
 *     transaction to defer the check to the end of). Verified against the live
 *     database rather than assumed.
 *  2. **Upsert** the whole list in one statement, conflict on the primary key.
 *     One statement is what makes a reorder legal: within it the deferred
 *     constraint tolerates two rows briefly sharing a position, which a swap
 *     necessarily does. Conflict on `id`, never on `(lead_id, position)` — a
 *     deferrable constraint cannot back an `ON CONFLICT` clause (42P10).
 *  3. **Read back**, so the caller adopts the ids the new rows were written with.
 *
 * Returns the persisted list. The caller must replace its local copy with it: the
 * placeholder ids it sent in are not the ones a test send or a launch can resolve.
 */
export async function saveSequence(
  leadId: string,
  steps: SequenceStep[]
): Promise<SequenceStep[]> {
  const keep = steps.filter((step) => isPersistedStepId(step.id)).map((step) => step.id)

  /*
   * What the deleted steps had attached, read *before* the delete cascades their
   * links away. Without this the row and the bucket object outlive every reference to
   * them — which applying a template over an existing sequence does on every use,
   * since it replaces the whole step list.
   */
  const orphanCandidates = await attachmentsOfDeletedSteps(leadId, keep)

  /*
   * `not in (…)` needs a non-empty list, and an empty `keep` means every existing
   * row is going — so the filter is dropped rather than built as `not.in.()`,
   * which PostgREST rejects.
   */
  const deletion = supabase.from("sequence_steps").delete().eq("lead_id", leadId)
  const { error: deleteError } = await (keep.length > 0
    ? deletion.not("id", "in", `(${keep.join(",")})`)
    : deletion)

  if (deleteError) throw new Error(deleteError.message)

  /*
   * After the delete, so the counts see the world without those links — and before
   * the upsert, which is when a re-keyed step would link the same file again.
   */
  await deleteIfUnreferenced(orphanCandidates)

  if (steps.length === 0) return []

  const rows = steps.map((step, index) => {
    const columns = stepToColumns(step, index)

    return {
      lead_id: leadId,
      /*
       * Every row carries an id — a persisted one so the upsert updates that row, a
       * freshly minted one for a step that only existed on screen (its placeholder
       * `email-<leadId>-2` is not a uuid and would fail the column type).
       *
       * Minting it here rather than letting `gen_random_uuid()` do it, which is the
       * opposite of how `leads` and `template_steps` are written, because PostgREST
       * derives ONE column list for the whole batch and sets that key to **null** in
       * any row that omitted it — the column default is not consulted. So the moment
       * a list mixes saved and new steps, omitting `id` is a 23502 on the new ones
       * rather than a generated uuid. Splitting the write in two would avoid that but
       * cost the single statement the deferred `(lead_id, position)` constraint needs
       * to tolerate a reorder. Verified against the live database.
       */
      id: isPersistedStepId(step.id) ? step.id : crypto.randomUUID(),
      position: columns.position,
      kind: columns.kind,
      name: columns.name,
      subject: columns.subject,
      body_html: columns.body_html,
      wait_days: columns.wait_days,
    }
  })

  const { data, error } = await supabase
    .from("sequence_steps")
    .upsert(rows, { onConflict: "id" })
    .select("*")

  if (error) throw new Error(error.message)

  /*
   * Attachments are carried over from the list that went in, keyed by id, rather
   * than re-queried or dropped.
   *
   * They have to come from somewhere: `sequence_steps` has no attachment column, so
   * the read-back knows nothing about them, and mapping the rows straight through
   * would blank every file on screen after an unrelated structural edit — a
   * reordered step would look like it lost its resume. Keying by id is sound
   * precisely because this function preserves ids (see the note above); a genuinely
   * new step has none yet, so `[]` is the truth for it rather than a guess.
   */
  const attachmentsById = new Map<string, StepAttachment[]>()
  for (const step of steps) {
    if (step.attachments) attachmentsById.set(step.id, step.attachments)
  }

  return [...(data ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((row) => {
      const step = stepFromRow(row)
      return step.kind === "email"
        ? { ...step, attachments: attachmentsById.get(row.id) ?? [] }
        : step
    })
}

/**
 * Persist edits to one already-saved step, leaving its id and position alone.
 *
 * Separate from `saveSequence` because keeping the id stable is what lets the
 * test-send button work on the step currently being typed into. Position is
 * deliberately not written: this is the debounced content path, and a position
 * write is the one thing that can collide.
 */
export async function saveStepContent(step: SequenceStep, position: number): Promise<void> {
  if (!isPersistedStepId(step.id)) {
    throw new Error("That step hasn't been saved yet.")
  }

  const columns = stepToColumns(step, position)

  const { error } = await supabase
    .from("sequence_steps")
    // Listed rather than spread-minus-`position`: `stepToColumns` emits `id` and
    // `position` too, and both have to stay out of this update.
    .update({
      kind: columns.kind,
      name: columns.name,
      subject: columns.subject,
      body_html: columns.body_html,
      wait_days: columns.wait_days,
    })
    .eq("id", step.id)

  if (error) throw new Error(error.message)
}

/**
 * Discard a lead's whole sequence, including any files only it was using.
 *
 * `step_attachments` cascades off the steps, so the links go on their own — but the
 * `attachments` rows and their bucket objects don't, which is why they're collected
 * first and pruned after.
 */
export async function deleteSequence(leadId: string): Promise<void> {
  const orphanCandidates = await attachmentsOfDeletedSteps(leadId, [])

  const { error } = await supabase.from("sequence_steps").delete().eq("lead_id", leadId)

  if (error) throw new Error(error.message)

  await deleteIfUnreferenced(orphanCandidates)
}
