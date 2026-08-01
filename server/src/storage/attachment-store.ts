import { db, unwrapMany } from "../db.ts"
import { loggerFor } from "../logger.ts"
import type { SendEmailInput } from "../email/gmail-mailer.ts"

/**
 * Supabase Storage → in-memory Buffers for the MIME builder.
 *
 * Same shape as the other wrappers: one class per external system, typed result,
 * typed error. Downloading into memory is fine here and only here — the bucket
 * caps files at 4 MB, and a resume is the only thing it holds.
 */

const log = loggerFor("attachments")

const BUCKET = "attachments"

/** Exactly what `GmailMailer` takes, so nothing reshapes it in between. */
export type EmailAttachment = NonNullable<SendEmailInput["attachments"]>[number]

/** A file the `attachments` row points at but Storage could not return. */
export class AttachmentMissingError extends Error {
  override readonly name = "AttachmentMissingError"

  constructor(readonly storagePath: string, message: string) {
    super(message)
  }
}

export class AttachmentStore {
  /**
   * Every file attached to one sequence step, ready to hand to `GmailMailer`.
   *
   * Throws rather than skipping a missing file: sending a cold email that
   * promises "my resume is attached" without the resume is worse than not
   * sending it, and the scheduler's retry/backoff can handle a transient
   * Storage failure.
   */
  async fetchForStep(stepId: string): Promise<EmailAttachment[]> {
    const links = await unwrapMany(
      "list step attachments",
      db
        .from("step_attachments")
        .select("attachments!inner(filename, storage_path, mime_type)")
        .eq("step_id", stepId)
    )

    const files = links.map((link) => link.attachments)
    if (files.length === 0) return []

    log.debug({ stepId, count: files.length }, "Fetching attachments")

    // Sequential rather than Promise.all: this runs inside the send loop, the
    // count is one or two, and a serial download keeps the failure that gets
    // reported the first one rather than whichever lost the race.
    const attachments: EmailAttachment[] = []
    for (const file of files) {
      attachments.push({
        filename: file.filename,
        content: await this.download(file.storage_path),
        contentType: file.mime_type,
      })
    }

    return attachments
  }

  /**
   * Template steps carry their own attachment links, so a test send from the
   * Templates page still arrives with the resume.
   */
  async fetchForTemplateStep(templateStepId: string): Promise<EmailAttachment[]> {
    const links = await unwrapMany(
      "list template step attachments",
      db
        .from("template_step_attachments")
        .select("attachments!inner(filename, storage_path, mime_type)")
        .eq("template_step_id", templateStepId)
    )

    const attachments: EmailAttachment[] = []
    for (const { attachments: file } of links) {
      attachments.push({
        filename: file.filename,
        content: await this.download(file.storage_path),
        contentType: file.mime_type,
      })
    }

    return attachments
  }

  private async download(storagePath: string): Promise<Buffer> {
    const { data, error } = await db.storage.from(BUCKET).download(storagePath)

    if (error || !data) {
      throw new AttachmentMissingError(
        storagePath,
        `Could not download ${storagePath}: ${error?.message ?? "no data returned"}`
      )
    }

    // A Blob, not a Node stream — supabase-js uses the fetch API. Converting via
    // arrayBuffer is the only path to a Buffer, and it is why the 4 MB cap on the
    // bucket matters: this is all resident memory.
    return Buffer.from(await data.arrayBuffer())
  }
}

export const attachmentStore = new AttachmentStore()
