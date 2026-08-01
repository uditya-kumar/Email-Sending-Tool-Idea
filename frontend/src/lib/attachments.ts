import { attachmentFromRow } from "@shared/mappers.ts"
import { checkAttachment } from "@shared/attachments.ts"
import type { StepAttachment } from "@shared/types.ts"
import { supabase, currentUserId } from "./supabase"

/**
 * Uploading and removing the files attached to one email step.
 *
 * Three things have to happen together and there is no transaction across them —
 * the Storage object, the `attachments` row and the `step_attachments` link. The
 * order below is chosen so that a failure at any point leaves nothing the user can
 * see and nothing that would be sent:
 *
 *  1. **Upload the object.** A file in the bucket with no row pointing at it is
 *     invisible and harmless — it costs storage, nothing more.
 *  2. **Insert the `attachments` row.**
 *  3. **Insert the `step_attachments` link.** Only now does the scheduler consider
 *     the file part of the email.
 *
 * Both later steps clean up after themselves on failure, so the common outcome is
 * no orphan at all. The reverse order would be genuinely dangerous: a link written
 * before the object exists is a scheduled email whose send fails with
 * `AttachmentMissingError`, and `attachment-store.ts` deliberately throws rather
 * than sending a cold email that promises a resume it hasn't got.
 */

const BUCKET = "attachments"

/**
 * Which kind of step a file is being linked to.
 *
 * The two link tables are separate because their parents are (`sequence_steps` vs
 * `template_steps`), but everything else about attaching is identical — so the
 * exported functions take an `owner` rather than being written twice.
 * `attachment-store.ts` makes the same split server-side for the same reason.
 *
 * The three helpers below are where the split is actually paid for. They branch on
 * `owner` and name both the table and its step column as literals, which is
 * unavoidably repetitive — a `{table, column}` lookup reads better but cannot be
 * typed: supabase-js derives the row shape from the literal table name, so a
 * variable one produces a union in which neither step column is known to exist, and
 * the only way through is a cast that would silence a genuine column rename.
 */
export type StepOwner = "sequence" | "template"

/** One `(step, attachment)` pair, with the link table's column name resolved. */
interface Link {
  stepId: string
  attachment: StepAttachment
}

async function selectLinks(stepIds: string[], owner: StepOwner): Promise<Link[]> {
  if (owner === "template") {
    const { data, error } = await supabase
      .from("template_step_attachments")
      .select("template_step_id, attachments!inner(*)")
      .in("template_step_id", stepIds)

    if (error) throw new Error(error.message)

    return (data ?? []).map((row) => ({
      stepId: row.template_step_id,
      attachment: attachmentFromRow(row.attachments),
    }))
  }

  const { data, error } = await supabase
    .from("step_attachments")
    .select("step_id, attachments!inner(*)")
    .in("step_id", stepIds)

  if (error) throw new Error(error.message)

  return (data ?? []).map((row) => ({
    stepId: row.step_id,
    attachment: attachmentFromRow(row.attachments),
  }))
}

/**
 * Point a step at files that already exist, ignoring links it already has.
 *
 * An upsert rather than an insert because the link table's primary key is
 * `(step_id, attachment_id)`: re-applying a template to a lead who already has the
 * file is a no-op, not an error.
 */
async function insertLinks(
  stepId: string,
  attachmentIds: string[],
  owner: StepOwner
): Promise<void> {
  const { error } =
    owner === "template"
      ? await supabase.from("template_step_attachments").upsert(
          attachmentIds.map((id) => ({ template_step_id: stepId, attachment_id: id })),
          { onConflict: "template_step_id,attachment_id", ignoreDuplicates: true }
        )
      : await supabase.from("step_attachments").upsert(
          attachmentIds.map((id) => ({ step_id: stepId, attachment_id: id })),
          { onConflict: "step_id,attachment_id", ignoreDuplicates: true }
        )

  if (error) throw new Error(error.message)
}

async function deleteLink(
  stepId: string,
  attachmentId: string,
  owner: StepOwner
): Promise<void> {
  const { error } =
    owner === "template"
      ? await supabase
          .from("template_step_attachments")
          .delete()
          .eq("template_step_id", stepId)
          .eq("attachment_id", attachmentId)
      : await supabase
          .from("step_attachments")
          .delete()
          .eq("step_id", stepId)
          .eq("attachment_id", attachmentId)

  if (error) throw new Error(error.message)
}

/**
 * Every file attached to a set of steps, keyed by step id.
 *
 * Batched over the whole list rather than queried per step: the compose flow shows
 * one step at a time but has all of them in memory, and the alternative is a
 * request per step every time the sequence loads.
 */
export async function fetchAttachmentsForSteps(
  stepIds: string[],
  owner: StepOwner = "sequence"
): Promise<Record<string, StepAttachment[]>> {
  if (stepIds.length === 0) return {}

  const links = await selectLinks(stepIds, owner)

  const byStep: Record<string, StepAttachment[]> = {}

  for (const { stepId, attachment } of links) {
    const list = byStep[stepId] ?? []
    list.push(attachment)
    byStep[stepId] = list
  }

  // Sorted by name so the list doesn't reshuffle between loads — the join has no
  // inherent order, and `created_at` ties on files added in the same second.
  for (const list of Object.values(byStep)) {
    list.sort((a, b) => a.filename.localeCompare(b.filename))
  }

  return byStep
}

/**
 * Every distinct file attached to a set of steps, as a flat list.
 *
 * Exists for the callers that are about to delete those steps: `step_attachments`
 * and `template_step_attachments` both cascade off their step, so after the delete
 * nothing records which files those steps had, and the `attachments` rows and bucket
 * objects would be unreachable rather than deleted. Read first, prune after — see
 * `deleteIfUnreferenced`.
 *
 * Deduplicated by id, because two doomed steps can share a file and the second pass
 * would then try to delete a row that's already gone.
 */
export async function attachmentsOfSteps(
  stepIds: string[],
  owner: StepOwner = "sequence"
): Promise<StepAttachment[]> {
  if (stepIds.length === 0) return []

  const byStep = await fetchAttachmentsForSteps(stepIds, owner)

  const unique = new Map<string, StepAttachment>()
  for (const list of Object.values(byStep)) {
    for (const attachment of list) unique.set(attachment.id, attachment)
  }

  return [...unique.values()]
}

/**
 * Attach one file to one **persisted** sequence step.
 *
 * `alreadyAttachedBytes` is the step's current total, so the size check is against
 * what the finished email would weigh rather than this file alone — Gmail's limit
 * applies to the whole message. See `MAX_ATTACHMENT_BYTES` for why the ceiling is
 * below the bucket's own.
 */
export async function attachFileToStep(
  stepId: string,
  file: File,
  alreadyAttachedBytes = 0,
  owner: StepOwner = "sequence"
): Promise<StepAttachment> {
  const check = checkAttachment(file, alreadyAttachedBytes)
  if (!check.ok) throw new Error(check.reason)

  const userId = await currentUserId()
  /*
   * `<user_id>/<uuid>.<ext>`. The first path segment is the ownership check in the
   * bucket's RLS policy (`storage.foldername(name)[1] = auth.uid()`), so it is not
   * cosmetic. A generated uuid rather than the original filename: two uploads of
   * "resume.pdf" would otherwise collide, and `storage_path` is unique.
   */
  const storagePath = `${userId}/${crypto.randomUUID()}.${check.extension}`

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, file, {
      /*
       * The type is set from the extension rather than passed through from
       * `File.type`, which browsers report as `""` for `.doc` on machines with no
       * Office association — and an empty type is refused by the bucket's
       * `allowed_mime_types` without saying why.
       */
      contentType: check.mimeType,
      // A fresh uuid can't collide, so an upsert would only mask a bug.
      upsert: false,
    })

  if (uploadError) throw new Error(uploadError.message)

  const { data: row, error: rowError } = await supabase
    .from("attachments")
    .insert({
      filename: file.name,
      storage_path: storagePath,
      mime_type: check.mimeType,
      size_bytes: file.size,
    })
    .select("*")
    .single()

  if (rowError) {
    // Best effort: the object is unreachable without a row, so a failed cleanup
    // wastes space rather than affecting anything that sends.
    await supabase.storage.from(BUCKET).remove([storagePath])
    throw new Error(rowError.message)
  }

  try {
    await insertLinks(stepId, [row.id], owner)
  } catch (cause) {
    // Unwind both, or the file would show up on no step while still occupying the
    // bucket. Deleting the row is enough to make it invisible either way.
    await supabase.from("attachments").delete().eq("id", row.id)
    await supabase.storage.from(BUCKET).remove([storagePath])
    throw cause
  }

  return attachmentFromRow(row)
}

/**
 * Detach a file from one step, and delete it only if no other step still uses it.
 *
 * The shared case is real and is the whole point of template attachments: applying
 * a template links the *same* `attachments` row to the recipient's new step rather
 * than re-uploading the file, so one stored resume is normally referenced by the
 * template step it was uploaded to plus every lead the template has been applied
 * to. Deleting the row here would cascade every one of those links away and rip
 * the resume out of emails the user never touched — including ones already queued
 * to send.
 *
 * So: drop this one link, count what's left, and delete the row and the object
 * only when nothing points at them. Reference counted rather than left to
 * accumulate, because otherwise removing a file from the only step using it would
 * leak both the row and the bucket object forever.
 */
export async function removeAttachment(
  attachment: StepAttachment,
  stepId: string,
  owner: StepOwner = "sequence"
): Promise<void> {
  await deleteLink(stepId, attachment.id, owner)
  await deleteIfUnreferenced([attachment])
}

/**
 * Delete the row and the bucket object for any of these files that nothing points at
 * any more.
 *
 * Separate from `removeAttachment` because links also disappear *without* anyone
 * detaching a file: `step_attachments.step_id` cascades, so deleting a step — or
 * applying a template over a lead's existing sequence, which replaces every step —
 * takes its links with it and leaves the row and the object behind. Called from the
 * step-list writes for that reason, not only from the detach button.
 *
 * Reference counted across **both** link tables. A file uploaded on a template step
 * and applied to three leads is referenced from `template_step_attachments` *and*
 * `step_attachments`, and counting only one of them would delete a resume three
 * queued emails still need.
 */
export async function deleteIfUnreferenced(
  attachments: StepAttachment[]
): Promise<void> {
  for (const attachment of attachments) {
    // `head: true` with an exact count asks Postgres for the number and no rows.
    const [sequenceLinks, templateLinks] = await Promise.all([
      supabase
        .from("step_attachments")
        .select("attachment_id", { count: "exact", head: true })
        .eq("attachment_id", attachment.id),
      supabase
        .from("template_step_attachments")
        .select("attachment_id", { count: "exact", head: true })
        .eq("attachment_id", attachment.id),
    ])

    if (sequenceLinks.error) throw new Error(sequenceLinks.error.message)
    if (templateLinks.error) throw new Error(templateLinks.error.message)

    /*
     * Still in use elsewhere — leave it alone. When this came from a detach the
     * user's intent ("not on this email") is already satisfied, and the file stays
     * available to the steps that do use it.
     *
     * A count that failed to come back throws above rather than arriving here as 0:
     * guessing "unused" wrongly deletes a resume out of a queued send, which is far
     * worse than leaking one file.
     */
    if ((sequenceLinks.count ?? 0) + (templateLinks.count ?? 0) > 0) continue

    const { error } = await supabase.from("attachments").delete().eq("id", attachment.id)

    if (error) throw new Error(error.message)

    const { error: storageError } = await supabase.storage
      .from(BUCKET)
      .remove([attachment.storagePath])

    /*
     * Reported rather than thrown. The links are already gone, so the file is not
     * part of any email; failing here would suggest otherwise, which is worse than a
     * leaked object.
     */
    if (storageError) {
      console.warn(
        `Removed the attachment but couldn't delete ${attachment.storagePath}:`,
        storageError.message
      )
    }
  }
}

/**
 * Link files that already exist in the bucket to a step — no upload.
 *
 * This is what makes applying a template carry its resume across: the template's
 * `attachments` rows are **shared** with the lead's new step rather than copied, so
 * one stored file serves every recipient the template is applied to. Copying the
 * objects instead would mean a hundred identical resumes in the bucket and a
 * hundred uploads, and re-picking the file by hand is exactly the chore this
 * removes.
 *
 * Re-applying a template to a lead who already has the file is a no-op rather than
 * an error — see `insertLinks`.
 */
export async function linkAttachmentsToStep(
  stepId: string,
  attachmentIds: string[],
  owner: StepOwner = "sequence"
): Promise<void> {
  if (attachmentIds.length === 0) return

  await insertLinks(stepId, attachmentIds, owner)
}

/** A short-lived URL for previewing a stored file. The bucket is private. */
export async function attachmentDownloadUrl(
  attachment: StepAttachment
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(attachment.storagePath, 60)

  if (error) throw new Error(error.message)

  return data.signedUrl
}
