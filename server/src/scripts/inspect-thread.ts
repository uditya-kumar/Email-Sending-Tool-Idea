/**
 * One-off: dump the RFC headers Gmail actually stored for a thread.
 *
 * Proves the three things threading needs are really on the wire — `Subject`,
 * `In-Reply-To`/`References` and a shared thread — rather than inferring it from
 * the `sends` row we wrote ourselves.
 *
 * Usage: npx tsx src/scripts/inspect-thread.ts <threadId>
 */
import { google } from "googleapis"
import { listActiveAccounts, oauthClientFor } from "../email/accounts.ts"

const threadId = process.argv[2]

if (!threadId) {
  console.error("Usage: npx tsx src/scripts/inspect-thread.ts <threadId>")
  process.exit(1)
}

const accounts = await listActiveAccounts()
const account = accounts[0]

if (!account) {
  console.error("No active Gmail account.")
  process.exit(1)
}

const gmail = google.gmail({ version: "v1", auth: oauthClientFor(account) })

const { data } = await gmail.users.threads.get({
  userId: "me",
  id: threadId,
  format: "metadata",
  metadataHeaders: ["From", "To", "Subject", "Message-ID", "In-Reply-To", "References", "Date"],
})

for (const message of data.messages ?? []) {
  console.log(`\n--- message ${message.id} ---`)
  for (const header of message.payload?.headers ?? []) {
    console.log(`${header.name}: ${header.value}`)
  }
}
