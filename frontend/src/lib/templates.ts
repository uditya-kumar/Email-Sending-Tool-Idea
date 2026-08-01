import { stepFromRow, stepToColumns } from "@shared/mappers.ts"
import type { EmailTemplate, SequenceStep, StepAttachment } from "@shared/types.ts"
import {
  attachmentsOfSteps,
  deleteIfUnreferenced,
  fetchAttachmentsForSteps,
  linkAttachmentsToStep,
} from "./attachments"
import { isPersistedStepId } from "./sequences"
import { supabase } from "./supabase"

/**
 * Persistence for templates and their steps.
 *
 * This exists because of one hard constraint in `POST /api/test-send`: the server
 * re-reads the step from `template_steps` by id and renders *that*, deliberately
 * never trusting content from the request body. A test send therefore cannot show
 * unsaved editor state — the row has to exist, with a real UUID, before the send.
 *
 * `user_id` is never written from here: the column defaults to `auth.uid()` and
 * RLS checks it, so supplying it would be both redundant and a way to get it
 * wrong.
 *
 * **Step ids are preserved on save** (`replaceSteps` upserts rather than
 * delete-then-inserts). That used to be the opposite, and it was fine while a
 * template was only text — but `template_step_attachments.template_step_id`
 * cascades, so a delete-then-insert silently threw away every attached file the
 * moment a step was added, reordered, or a delay changed. See `replaceSteps`.
 */

/**
 * Every template with its steps and the files attached to them.
 *
 * Two round trips, not one per template: the attachment links come back in a single
 * batched query keyed by step id, the same shape `fetchAllSequences` uses. Loaded
 * eagerly rather than on template selection because the whole list is small and the
 * alternative is the attachment bar popping in a beat after the editor.
 */
export async function fetchTemplates(): Promise<EmailTemplate[]> {
  const { data, error } = await supabase
    .from("templates")
    .select("id, name, created_at, template_steps(*)")
    .order("created_at", { ascending: true })

  if (error) throw error

  const rows = data ?? []

  const emailStepIds = rows.flatMap((row) =>
    row.template_steps.filter((step) => step.kind === "email").map((step) => step.id)
  )
  const byStep = await fetchAttachmentsForSteps(emailStepIds, "template")

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    // Postgres doesn't guarantee order inside an embedded select, so sort here
    // rather than trusting the order the rows arrive in.
    steps: [...row.template_steps]
      .sort((a, b) => a.position - b.position)
      /*
       * Wrapped rather than passed by reference: `map` would fill `stepFromRow`'s
       * second argument with the index. Email steps get `[]` when they have no
       * files — `undefined` means "not loaded" downstream, and these are loaded.
       * Delay steps get nothing at all: they cannot carry a file, and an empty array
       * on them would imply the concept applies. Same rule as `withAttachments`.
       */
      .map((step) => {
        const mapped = stepFromRow(step)
        return mapped.kind === "email"
          ? { ...mapped, attachments: byStep[step.id] ?? [] }
          : mapped
      }),
  }))
}

/**
 * Create a template and its steps, returning it with the **database's** ids.
 *
 * Returning the persisted shape is the whole contract: the caller must replace
 * its local copy with this, because the ids it invented client-side are not the
 * ones a test send can resolve.
 */
export async function createTemplate(
  name: string,
  steps: SequenceStep[]
): Promise<EmailTemplate> {
  const { data: template, error } = await supabase
    .from("templates")
    .insert({ name })
    .select("id, name")
    .single()

  if (error) throw error

  const saved = await replaceSteps(template.id, steps)

  return { id: template.id, name: template.name, steps: saved }
}

export async function renameTemplate(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("templates").update({ name }).eq("id", id)
  if (error) throw error
}

/**
 * Delete a template, including any files only it was using.
 *
 * `template_steps` cascades off `templates` and `template_step_attachments` cascades
 * off those, so the rows in between need no statement of their own — but the
 * `attachments` rows and their bucket objects are not reachable by any cascade, which
 * is why they're collected first and pruned after. Files the template shares with a
 * lead it was applied to survive; see `deleteIfUnreferenced`.
 */
export async function deleteTemplate(id: string): Promise<void> {
  const { data: steps, error: stepsError } = await supabase
    .from("template_steps")
    .select("id")
    .eq("template_id", id)

  if (stepsError) throw stepsError

  const orphanCandidates = await attachmentsOfSteps(
    (steps ?? []).map((step) => step.id),
    "template"
  )

  const { error } = await supabase.from("templates").delete().eq("id", id)
  if (error) throw error

  await deleteIfUnreferenced(orphanCandidates)
}

/**
 * Overwrite a template's whole step list, **keeping the ids of steps that already
 * belong to this template**.
 *
 * This mirrors `saveSequence` in `sequences.ts`, and for the same reason: a
 * delete-then-insert reassigns every id, and `template_step_attachments` cascades
 * off `template_steps`. So the old implementation dropped every attached file
 * whenever a step was added, deleted, reordered, or a delay length changed — the
 * user's resume would vanish from a template because they nudged a wait from 3 days
 * to 4. Text-only templates never noticed.
 *
 * Three statements, in this order:
 *
 *  1. **Delete** the rows that are gone. First, because a step removed from the
 *     middle frees a position a later step is about to occupy, and PostgREST
 *     autocommits each statement separately — there is no transaction for the
 *     deferred `(template_id, position)` constraint to defer to.
 *  2. **Upsert** the whole list in one statement, conflict on the primary key.
 *     One statement is what makes a reorder legal: within it the deferred
 *     constraint tolerates two rows briefly sharing a position. Never conflict on
 *     `(template_id, position)` — a deferrable constraint can't back `ON CONFLICT`
 *     (42P10).
 *  3. **Read back**, so the caller adopts the ids the new rows were written with.
 *
 * `reuse` guards the one case where preserving an id would be wrong: `duplicate`
 * passes the *source* template's steps, whose ids are real UUIDs belonging to
 * another template. Upserting those would **move** the original's rows into the
 * copy — taking their attachments with them — instead of creating new ones. So an
 * id is only reused when it is already a step of *this* template; anything else
 * gets a fresh uuid, and its files are re-linked to the new row.
 */
export async function replaceSteps(
  templateId: string,
  steps: SequenceStep[]
): Promise<SequenceStep[]> {
  /*
   * Which ids genuinely belong here, read rather than inferred. `isPersistedStepId`
   * only proves a string is a uuid, not whose it is — and the difference is
   * `duplicate` silently gutting the template it copied from.
   */
  const { data: existing, error: existingError } = await supabase
    .from("template_steps")
    .select("id")
    .eq("template_id", templateId)

  if (existingError) throw existingError

  const ownIds = new Set((existing ?? []).map((row) => row.id))
  const reuse = (id: string) => isPersistedStepId(id) && ownIds.has(id)

  const keep = steps.filter((step) => reuse(step.id)).map((step) => step.id)

  /*
   * What the doomed steps had attached, read before the delete cascades their links
   * away — afterwards nothing says which files they were, and the rows and bucket
   * objects would be unreachable rather than deleted.
   */
  const doomed = [...ownIds].filter((id) => !keep.includes(id))
  const orphanCandidates = await attachmentsOfSteps(doomed, "template")

  /*
   * `not in (…)` needs a non-empty list, and an empty `keep` means every existing
   * row is going — so the filter is dropped rather than built as `not.in.()`,
   * which PostgREST rejects.
   */
  const deletion = supabase.from("template_steps").delete().eq("template_id", templateId)
  const { error: deleteError } = await (keep.length > 0
    ? deletion.not("id", "in", `(${keep.join(",")})`)
    : deletion)

  if (deleteError) throw deleteError

  /*
   * After the delete, so the reference counts see the world without those links —
   * and before the upsert, which is when a re-keyed step links the same file again.
   */
  await deleteIfUnreferenced(orphanCandidates)

  if (steps.length === 0) return []

  const rows = steps.map((step, i) => {
    const columns = stepToColumns(step, i)
    return {
      template_id: templateId,
      /*
       * Every row carries an id — its own where it has one here, a freshly minted
       * uuid otherwise (a client-side "email-t1-3-1" is not a uuid and would fail
       * the column type).
       *
       * Minted client-side rather than left to `gen_random_uuid()` because
       * PostgREST derives ONE column list for the whole batch and sets that key to
       * **null** in any row that omitted it — the column default is not consulted.
       * So the moment a list mixes saved and new steps, omitting `id` is a 23502 on
       * the new ones. Same reasoning as `saveSequence`.
       */
      id: reuse(step.id) ? step.id : crypto.randomUUID(),
      position: columns.position,
      kind: columns.kind,
      name: columns.name,
      subject: columns.subject,
      body_html: columns.body_html,
      wait_days: columns.wait_days,
    }
  })

  const { data, error } = await supabase
    .from("template_steps")
    .upsert(rows, { onConflict: "id" })
    .select("*")

  if (error) throw error

  /*
   * Attachments carried over from the list that went in, keyed by the id the row was
   * *written* with rather than the id it arrived with — the two differ for a re-keyed
   * step. `rows[i]` was built from `steps[i]`, so the index is the pairing.
   *
   * They have to come from somewhere: `template_steps` has no attachment column, so
   * the read-back knows nothing about them, and mapping the rows straight through
   * would blank every file on screen after an unrelated structural edit — a step
   * whose delay changed would look like it lost its resume.
   */
  const attachmentsById = new Map<string, StepAttachment[]>()
  /*
   * Links that need creating: a re-keyed step's files are attached to the *source*
   * row, and nothing points them at the new one. This is what makes Duplicate copy a
   * template's attachments — sharing the same `attachments` rows rather than
   * re-uploading, which is also why deleting one is reference-counted.
   */
  const linking: Array<{ stepId: string; attachmentIds: string[] }> = []

  for (const [i, step] of steps.entries()) {
    const row = rows[i]
    if (!row) continue

    if (step.attachments) attachmentsById.set(row.id, step.attachments)

    if (row.id !== step.id && step.attachments && step.attachments.length > 0) {
      linking.push({ stepId: row.id, attachmentIds: step.attachments.map((f) => f.id) })
    }
  }

  /*
   * After the upsert, not before: the link's FK points at a `template_steps` row that
   * doesn't exist yet. Sequential, so a failure reports as itself rather than as one
   * of five.
   */
  for (const { stepId, attachmentIds } of linking) {
    await linkAttachmentsToStep(stepId, attachmentIds, "template")
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
 * Persist edits to one already-saved step.
 *
 * Separate from `replaceSteps` because it keeps the row's id stable, which is what
 * lets the test-send button work on the step currently being edited. Reordering
 * still goes through `replaceSteps`.
 */
export async function saveStep(step: SequenceStep, position: number): Promise<void> {
  const { id, ...columns } = stepToColumns(step, position)

  const { error } = await supabase.from("template_steps").update(columns).eq("id", id)

  if (error) throw error
}
