import nodemailer from "nodemailer"
import { google, type gmail_v1 } from "googleapis"
import type { OAuth2Client } from "google-auth-library"
import { loggerFor } from "../logger.ts"

/**
 * Everything Gmail-specific lives behind this class, so the scheduler reads as
 * business logic and every Gmail quirk has exactly one home.
 *
 * The three quirks worth knowing about, all handled here:
 *  1. Gmail **overwrites** the `Message-ID` Nodemailer generates, so the real one
 *     has to be read back after sending or header-based threading breaks.
 *  2. Threading needs all three of a matching `Subject`, `In-Reply-To`/
 *     `References`, and `threadId`. Two out of three silently detaches the
 *     message in some clients.
 *  3. `messages.send` with a JSON body caps out at 5 MB of base64.
 */

export interface SendEmailInput {
  to: string
  subject: string
  text?: string
  html?: string
  replyTo?: string

  /**
   * Gmail thread ID returned by a previous Gmail API send.
   * Required when adding a follow-up to an existing Gmail thread.
   * Gmail also requires the subject to match the parent message exactly,
   * otherwise it starts a new thread regardless of this value.
   */
  threadId?: string

  /**
   * RFC Message-ID of the message being replied to, such as
   * "<CAB...@mail.gmail.com>". This is not the Gmail API message ID.
   * Read it from SendEmailResult.rfcMessageId of the parent send.
   */
  inReplyTo?: string

  /**
   * Every RFC Message-ID earlier in the conversation, oldest first.
   */
  references?: string[]

  attachments?: Array<{
    filename: string
    content: Buffer
    contentType?: string
  }>
}

export interface SendEmailResult {
  /**
   * Gmail's internal message identifier. Use it for Gmail API calls.
   */
  gmailMessageId: string

  /**
   * Gmail's conversation/thread identifier. Pass it as threadId on follow-ups.
   */
  threadId: string

  /**
   * The RFC Message-ID Gmail assigned to the sent message, read back from the
   * Gmail API after sending.
   *
   * Gmail always overwrites the Message-ID that Nodemailer generates, so the
   * value Nodemailer reports is discarded and must never be persisted — a
   * follow-up referencing it would be shown as a detached message by any client
   * that threads on headers rather than Gmail's threadId.
   *
   * **Optional, because reading it is a second API call made after the message has
   * already been delivered.** It used to be required, and a transient 503 on that
   * read threw `GmailRateLimitError` out of `send()` — indistinguishable from the
   * message never having gone out. The tick called `markFailed`, the row went back
   * to `pending`, and the recipient got the same email again on the next attempt.
   * Absent means threading falls back to `threadId` alone, which Gmail's own client
   * honours; a slightly-worse-threaded follow-up is a far better outcome than a
   * duplicate.
   */
  rfcMessageId?: string
}

/** The connected account needs to be re-authorized before it can send again. */
export class GmailAuthError extends Error {
  override readonly name = "GmailAuthError"
}

/** Gmail is throttling or the daily quota is exhausted; back off and retry. */
export class GmailRateLimitError extends Error {
  override readonly name = "GmailRateLimitError"
}

/** The message itself is unacceptable — bad address, oversized MIME. */
export class GmailMessageError extends Error {
  override readonly name = "GmailMessageError"
}

/**
 * Beyond this, `messages.send` needs the resumable upload endpoint instead of a
 * JSON body. Attachments are capped at 4 MB on upload precisely so a normal send
 * never reaches it.
 */
const MAX_RAW_LENGTH = 5_000_000

const log = loggerFor("gmail-mailer")

export class GmailMailer {
  private readonly gmail: gmail_v1.Gmail

  /*
   * Stream transport does not deliver through SMTP. It only generates the
   * complete MIME message — boundaries, quoted-printable, UTF-8 headers and
   * attachment encoding — which is the part that is genuinely tedious to get
   * right by hand. Gmail's API does the actual delivery.
   */
  private readonly mimeBuilder = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows", // CRLF, per RFC 5322
  })

  constructor(
    private readonly fromAddress: string,
    private readonly fromName: string,
    oauthClient: OAuth2Client
  ) {
    this.gmail = google.gmail({ version: "v1", auth: oauthClient })
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!input.text && !input.html) {
      throw new GmailMessageError("An email must contain text or HTML content.")
    }

    const raw = await this.buildMime(input)

    const sent = await this.call(() =>
      this.gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw,
          // Conditional spread, not `threadId: input.threadId` — under
          // exactOptionalPropertyTypes an explicit `undefined` is not the same
          // as an absent key, and sending the key at all changes Gmail's
          // behaviour.
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      })
    )

    const gmailMessageId = sent.data.id
    const threadId = sent.data.threadId

    // googleapis types these as `string | null | undefined` and that is
    // accurate. Branching rather than asserting is what stops an `undefined`
    // reaching the `sends` row, where it would break the next follow-up.
    if (!gmailMessageId || !threadId) {
      throw new GmailMessageError(
        "Gmail accepted the message but returned no message ID and thread ID."
      )
    }

    /*
     * Past this point the email has been delivered, so nothing may throw. Reading
     * the Message-ID back is a *second* API call, and `send()` throwing after a
     * successful delivery is a lie the scheduler acts on: `markFailed` puts the row
     * back to `pending` and the next tick sends the same email again. A transient
     * 503 on this read used to do exactly that.
     */
    const rfcMessageId = await this.readMessageIdOrNull(gmailMessageId)

    return {
      gmailMessageId,
      threadId,
      ...(rfcMessageId ? { rfcMessageId } : {}),
    }
  }

  /**
   * `readMessageId`, downgraded to a `null` on any failure.
   *
   * Worth having as its own method so the reason is stated once: everything from
   * here is best-effort, because the message is already in the recipient's inbox.
   * Losing the header costs header-based threading on the next follow-up (Gmail
   * still threads on `threadId`); throwing costs the recipient a duplicate email.
   */
  private async readMessageIdOrNull(gmailMessageId: string): Promise<string | null> {
    try {
      return await this.readMessageId(gmailMessageId)
    } catch (error) {
      log.warn(
        { err: error, gmailMessageId },
        "Message was sent but its Message-ID could not be read back; follow-ups will thread on threadId alone"
      )
      return null
    }
  }

  /** Compose the RFC 5322 message and encode it the way `raw` expects. */
  private async buildMime(input: SendEmailInput): Promise<string> {
    const headers: Record<string, string> = {}

    if (input.inReplyTo) {
      headers["In-Reply-To"] = input.inReplyTo
    }
    if (input.references?.length) {
      headers.References = input.references.join(" ")
    }

    const generated = await this.mimeBuilder.sendMail({
      from: { name: this.fromName, address: this.fromAddress },
      to: input.to,
      subject: input.subject,
      headers,
      ...(input.text ? { text: input.text } : {}),
      ...(input.html ? { html: input.html } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    })

    if (!Buffer.isBuffer(generated.message)) {
      throw new GmailMessageError("Nodemailer did not generate a buffered MIME message.")
    }

    const raw = generated.message.toString("base64url")

    if (raw.length > MAX_RAW_LENGTH) {
      throw new GmailMessageError(
        `MIME message is ${raw.length} bytes, over the 5 MB limit of messages.send. ` +
          "Use a smaller attachment."
      )
    }

    return raw
  }

  /**
   * Fetch the Message-ID header Gmail assigned to a message it just sent.
   * Follow-up threading depends on this value, so a missing header is fatal
   * rather than something to paper over with an empty string.
   */
  private async readMessageId(gmailMessageId: string): Promise<string> {
    const message = await this.call(() =>
      this.gmail.users.messages.get({
        userId: "me",
        id: gmailMessageId,
        format: "metadata",
        metadataHeaders: ["Message-ID"],
      })
    )

    const header = message.data.payload?.headers?.find(
      (h) => h.name?.toLowerCase() === "message-id"
    )

    if (!header?.value) {
      throw new GmailMessageError(
        `Gmail returned no Message-ID header for message ${gmailMessageId}.`
      )
    }

    return header.value
  }

  /**
   * Translate Google's error shapes into the three cases the scheduler acts on:
   * stop using this account, retry it later, or give up on this message.
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      throw translateGmailError(error)
    }
  }
}

/** The parts of a googleapis / gaxios error this code reads. */
interface GoogleApiErrorShape {
  message?: unknown
  code?: unknown
  status?: unknown
  response?: { status?: unknown; data?: unknown }
  errors?: Array<{ reason?: unknown }>
}

/**
 * Classify a Gmail failure without `as any`.
 *
 * The status arrives in one of three places depending on whether gaxios, the
 * OAuth library, or Node's network stack produced the error, so all three are
 * checked. Anything unrecognised is re-thrown unchanged — misclassifying an
 * unknown failure as "retry later" would loop forever.
 */
export function translateGmailError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error

  const shape = error as GoogleApiErrorShape
  const message = typeof shape.message === "string" ? shape.message : "unknown error"

  const status = firstNumber(shape.response?.status, shape.status, shape.code)
  const reasons = collectReasons(shape)

  // invalid_grant is the important one: the refresh token is dead (revoked,
  // password changed, or the 7-day Testing-mode expiry) and no amount of
  // retrying will fix it — the account must be reconnected.
  if (
    status === 401 ||
    reasons.includes("invalid_grant") ||
    reasons.includes("invalid_client") ||
    message.includes("invalid_grant")
  ) {
    return new GmailAuthError(`Gmail authorization failed: ${message}`)
  }

  if (status === 429) {
    return new GmailRateLimitError(`Gmail throttled the request: ${message}`)
  }

  /*
   * 403 is ambiguous and the split matters: `rateLimitExceeded` /
   * `userRateLimitExceeded` / `quotaExceeded` mean "back off", while
   * `insufficientPermissions` / `accessNotConfigured` mean the granted scopes or
   * the Cloud project are wrong and retrying is pointless.
   */
  if (status === 403) {
    const throttled = reasons.some((reason) =>
      ["ratelimitexceeded", "userratelimitexceeded", "quotaexceeded", "dailylimitexceeded"].includes(
        reason.toLowerCase()
      )
    )
    return throttled
      ? new GmailRateLimitError(`Gmail quota exceeded: ${message}`)
      : new GmailAuthError(`Gmail refused the request: ${message}`)
  }

  if (status === 400 || status === 413) {
    return new GmailMessageError(`Gmail rejected the message: ${message}`)
  }

  // 5xx and transport failures are transient by definition.
  if (typeof status === "number" && status >= 500) {
    return new GmailRateLimitError(`Gmail is unavailable (${status}): ${message}`)
  }

  return error
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number") return value
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

/** Every `reason` string Google might have attached, wherever it hid it. */
function collectReasons(shape: GoogleApiErrorShape): string[] {
  const reasons: string[] = []

  for (const entry of shape.errors ?? []) {
    if (typeof entry.reason === "string") reasons.push(entry.reason)
  }

  const data = shape.response?.data

  if (typeof data === "string") {
    reasons.push(data)
  } else if (typeof data === "object" && data !== null) {
    const body = data as { error?: unknown; error_description?: unknown }
    if (typeof body.error === "string") reasons.push(body.error)
    if (typeof body.error_description === "string") reasons.push(body.error_description)

    if (typeof body.error === "object" && body.error !== null) {
      const nested = body.error as { errors?: Array<{ reason?: unknown }> }
      for (const entry of nested.errors ?? []) {
        if (typeof entry.reason === "string") reasons.push(entry.reason)
      }
    }
  }

  return reasons
}
