import { google, type gmail_v1 } from "googleapis"
import type { OAuth2Client } from "google-auth-library"
import { translateGmailError } from "./gmail-mailer.ts"

/**
 * Reply detection: has anyone other than us posted to this thread?
 *
 * Deliberately uses `threads.get` rather than `messages.list?q=`. Two reasons:
 * a thread lookup is one call with no search-index lag, and it keeps the door
 * open to downgrading from `gmail.readonly` to the tighter `gmail.metadata`
 * scope — under which the `q` parameter is a hard 403.
 */

export interface ReplyCheck {
  replied: boolean
  /** When the earliest inbound message arrived. Absent when `replied` is false. */
  at?: Date
  /** The address that replied, for the log line. */
  from?: string
}

/** Parse `"Some One <a@b.com>"` down to `a@b.com`. */
function addressOf(header: string): string {
  const angled = /<([^>]+)>/.exec(header)
  return (angled?.[1] ?? header).trim().toLowerCase()
}

export class ReplyWatcher {
  private readonly gmail: gmail_v1.Gmail

  constructor(
    oauthClient: OAuth2Client,
    /** The connected account's own address — anything else in the thread is a reply. */
    private readonly selfAddress: string
  ) {
    this.gmail = google.gmail({ version: "v1", auth: oauthClient })
  }

  /**
   * True when the thread contains a message from anyone but the sender.
   *
   * `From` is the signal rather than Gmail's own labels: an automated bounce, a
   * vacation autoresponder and a real reply are all "someone else wrote in this
   * thread", and all three are equally good reasons to stop following up.
   */
  async hasInboundReply(threadId: string): Promise<ReplyCheck> {
    const self = this.selfAddress.toLowerCase()

    let thread: gmail_v1.Schema$Thread
    try {
      const response = await this.gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From", "Date"],
      })
      thread = response.data
    } catch (error) {
      throw translateGmailError(error)
    }

    for (const message of thread.messages ?? []) {
      const from = message.payload?.headers?.find(
        (h) => h.name?.toLowerCase() === "from"
      )?.value

      if (!from || addressOf(from) === self) continue

      /*
       * internalDate is Gmail's own receive timestamp in epoch milliseconds, as
       * a string. Preferred over the Date header, which is set by the sender's
       * client and is regularly wrong or missing.
       */
      const receivedAt = message.internalDate ? Number(message.internalDate) : NaN

      return {
        replied: true,
        from: addressOf(from),
        ...(Number.isFinite(receivedAt) ? { at: new Date(receivedAt) } : {}),
      }
    }

    return { replied: false }
  }
}
