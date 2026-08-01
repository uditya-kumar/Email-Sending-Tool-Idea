import { stepFromRow, stepToColumns } from "@shared/mappers.ts"
import type { EmailTemplate, SequenceStep } from "@shared/types.ts"
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
 */

/** One round trip: templates plus their steps, ordered. */
export async function fetchTemplates(): Promise<EmailTemplate[]> {
  const { data, error } = await supabase
    .from("templates")
    .select("id, name, created_at, template_steps(*)")
    .order("created_at", { ascending: true })

  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    // Postgres doesn't guarantee order inside an embedded select, so sort here
    // rather than trusting the order the rows arrive in.
    steps: [...row.template_steps]
      .sort((a, b) => a.position - b.position)
      .map(stepFromRow),
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

export async function deleteTemplate(id: string): Promise<void> {
  // `template_steps` cascades on the FK, so this is one statement.
  const { error } = await supabase.from("templates").delete().eq("id", id)
  if (error) throw error
}

/**
 * Overwrite a template's whole step list, delete-then-insert.
 *
 * A diff would be gentler on the database but far harder to get right against the
 * `(template_id, position)` unique constraint, which a reorder violates
 * transiently. Deleting first sidesteps that entirely, and a template has single
 * digits worth of steps. Ids are **not** preserved — Postgres assigns new ones —
 * which is why the fresh list is returned rather than assumed.
 */
export async function replaceSteps(
  templateId: string,
  steps: SequenceStep[]
): Promise<SequenceStep[]> {
  const { error: deleteError } = await supabase
    .from("template_steps")
    .delete()
    .eq("template_id", templateId)

  if (deleteError) throw deleteError

  if (steps.length === 0) return []

  const rows = steps.map((step, i) => {
    const columns = stepToColumns(step, i)
    return {
      template_id: templateId,
      // `stepToColumns` also emits `id`, deliberately not spread here: the
      // client-side ids ("email-t1-3-1") aren't UUIDs and would fail the column
      // type. Postgres generates one instead, which is why the inserted rows are
      // read back and returned.
      position: columns.position,
      kind: columns.kind,
      name: columns.name,
      subject: columns.subject,
      body_html: columns.body_html,
      wait_days: columns.wait_days,
    }
  })

  const { data, error } = await supabase.from("template_steps").insert(rows).select("*")

  if (error) throw error

  return [...(data ?? [])].sort((a, b) => a.position - b.position).map(stepFromRow)
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
