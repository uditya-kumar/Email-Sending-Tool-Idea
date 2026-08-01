/**
 * Print the id of the most recent `[TEST]` message in the connected mailbox.
 *
 * Exists to feed `inspect-attachments.ts`, which needs an id: after a test send the
 * id is only in the server log, and reading it back out of Gmail is one less thing to
 * copy by hand.
 *
 * Usage: npx tsx src/scripts/latest-test-message.ts
 */
import { google } from "googleapis"
import { listActiveAccounts, oauthClientFor } from "../email/accounts.ts"

const accounts = await listActiveAccounts()
const account = accounts[0]

if (!account) {
  console.error("No active Gmail account.")
  process.exit(1)
}

const gmail = google.gmail({ version: "v1", auth: oauthClientFor(account) })

const { data } = await gmail.users.messages.list({
  userId: "me",
  // `subject:` rather than a label: a test send lands in Sent and in the recipient's
  // inbox, and either copy carries the same parts.
  q: 'subject:"[TEST]"',
  maxResults: 5,
})

for (const message of data.messages ?? []) {
  console.log(message.id)
}
