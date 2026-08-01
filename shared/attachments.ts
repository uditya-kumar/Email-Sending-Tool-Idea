/**
 * What an email may carry as an attachment, and how large it may get.
 *
 * Shared because three layers have to agree on the same numbers: the browser
 * (which must refuse a file *before* uploading it), the Storage bucket (whose own
 * limits produce a 413 with no useful message), and `GmailMailer` (which refuses
 * an oversized MIME message after the file is already stored).
 */

/**
 * The only file types the bucket accepts, keyed by extension.
 *
 * Keyed by extension rather than trusting `File.type`, which is genuinely
 * unreliable: browsers report `""` for `.doc` on machines with no Office
 * association, and an empty content type is rejected by the bucket's
 * `allowed_mime_types` with no indication of why. The extension is the thing the
 * user can see and correct.
 *
 * Must stay in step with `allowed_mime_types` on the `attachments` bucket in
 * `schema.sql` — a type listed here and not there fails at upload.
 */
export const ATTACHMENT_MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

/** For an `accept` attribute: ".pdf,.doc,.docx". */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_MIME_TYPES)
  .map((extension) => `.${extension}`)
  .join(",")

/**
 * The most one email step's attachments may total, in bytes.
 *
 * **Deliberately below the bucket's own 4 MB cap**, because 4 MB does not
 * actually fit. `messages.send` takes the whole MIME message base64-encoded and
 * `GmailMailer` refuses anything over `MAX_RAW_LENGTH` (5,000,000); base64 inflates
 * by 4/3, so a bucket-legal 4 MB file becomes ~5.33 MB of `raw` and the send fails
 * — after the upload has already succeeded, which is the worst place to find out.
 * 5,000,000 × 3/4 ≈ 3.75 MB is the true ceiling; 3.5 MB leaves room for the
 * headers, the HTML body and the plain-text alternative that share the message.
 *
 * Applied to the step's **total**, not to each file: Gmail's limit is per message,
 * and two 3 MB files attached to one email would each pass a per-file check and
 * then fail together.
 */
export const MAX_ATTACHMENT_BYTES = 3_500_000

/** The lowercased extension of a filename, or null when it has none. */
export function attachmentExtension(filename: string): string | null {
  const dot = filename.lastIndexOf(".")
  if (dot === -1 || dot === filename.length - 1) return null
  return filename.slice(dot + 1).toLowerCase()
}

/** The content type to store a file as, or null when the type isn't allowed. */
export function attachmentMimeType(filename: string): string | null {
  const extension = attachmentExtension(filename)
  if (!extension) return null
  return ATTACHMENT_MIME_TYPES[extension] ?? null
}

export type AttachmentCheck =
  | { ok: true; mimeType: string; extension: string }
  /** `reason` is written to be shown to the user unchanged. */
  | { ok: false; reason: string }

/**
 * Whether a chosen file can be attached to a step that already holds
 * `attachedBytes` worth of files.
 *
 * Every rejection here is one the database or Gmail would also reject, just with a
 * worse message and after a pointless round trip.
 */
export function checkAttachment(
  file: { name: string; size: number },
  attachedBytes = 0
): AttachmentCheck {
  const extension = attachmentExtension(file.name)
  const mimeType = extension ? ATTACHMENT_MIME_TYPES[extension] : undefined

  if (!extension || !mimeType) {
    return {
      ok: false,
      reason: `Only ${Object.keys(ATTACHMENT_MIME_TYPES)
        .map((e) => e.toUpperCase())
        .join(", ")} files can be attached.`,
    }
  }

  // The `size_bytes > 0` CHECK would reject this anyway, and an empty file is
  // never what the user meant to send.
  if (file.size <= 0) {
    return { ok: false, reason: "That file is empty." }
  }

  if (attachedBytes + file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason:
        attachedBytes > 0
          ? `That would take this email over ${formatAttachmentSize(
              MAX_ATTACHMENT_BYTES
            )} of attachments. Remove a file first.`
          : `Attachments have to be under ${formatAttachmentSize(
              MAX_ATTACHMENT_BYTES
            )} — that one is ${formatAttachmentSize(file.size)}.`,
    }
  }

  return { ok: true, mimeType, extension }
}

/** Byte count as something a person reads, e.g. "412 KB", "1.8 MB". */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`

  return `${(kb / 1024).toFixed(1)} MB`
}
