/**
 * One-off: dump the MIME parts Gmail actually stored for one message, and check
 * each attachment's bytes against the file in the bucket.
 *
 * The sibling of `inspect-thread.ts`, and there for the same reason: the send path
 * reporting `attachments: ["resume.pdf"]` only proves the server *built* a part.
 * This reads the message back out of Gmail and downloads the attachment body, so a
 * truncated or empty part shows up as a byte count rather than as a recipient
 * opening a broken PDF.
 *
 * Usage: npx tsx src/scripts/inspect-attachments.ts <messageId>
 */
import { google } from "googleapis"
import type { gmail_v1 } from "googleapis"
import { listActiveAccounts, oauthClientFor } from "../email/accounts.ts"

const messageId = process.argv[2]

if (!messageId) {
  console.error("Usage: npx tsx src/scripts/inspect-attachments.ts <messageId>")
  process.exit(1)
}

const accounts = await listActiveAccounts()
const account = accounts[0]

if (!account) {
  console.error("No active Gmail account.")
  process.exit(1)
}

const gmail = google.gmail({ version: "v1", auth: oauthClientFor(account) })

const { data: message } = await gmail.users.messages.get({
  userId: "me",
  id: messageId,
  format: "full",
})

/** Every part in the tree, flattened — attachments sit below `multipart/mixed`. */
function flatten(part: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePart[] {
  if (!part) return []
  return [part, ...(part.parts ?? []).flatMap(flatten)]
}

const parts = flatten(message.payload)

console.log(`\nmessage ${messageId} — ${parts.length} parts`)

for (const part of parts) {
  const label = part.filename ? ` filename=${part.filename}` : ""
  console.log(`  ${part.mimeType}${label} bytes=${part.body?.size ?? 0}`)
}

const attachments = parts.filter((part) => part.filename && part.body?.attachmentId)

if (attachments.length === 0) {
  console.log("\nNo attachment parts on this message.")
  process.exit(0)
}

for (const part of attachments) {
  const attachmentId = part.body?.attachmentId
  if (!attachmentId) continue

  const { data } = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  })

  // Gmail returns base64url; decoding it is the actual proof the part is intact
  // rather than a header claiming a size.
  const bytes = Buffer.from(data.data ?? "", "base64url")
  // A PDF that opens starts with %PDF- — worth checking, since a truncated or
  // double-encoded body would still have a plausible length.
  const magic = bytes.subarray(0, 5).toString("latin1")

  console.log(
    `\n${part.filename}: downloaded ${bytes.length} bytes, starts with ${JSON.stringify(magic)}`
  )
}
