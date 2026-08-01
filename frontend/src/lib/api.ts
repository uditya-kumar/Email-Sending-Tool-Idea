import type { LeadStatus } from "@shared/types.ts"
import { accessToken } from "./supabase"

/**
 * The browser's client for our own Express server.
 *
 * Almost all data access goes straight to Supabase under RLS (see `supabase.ts`);
 * this covers only the handful of things that cannot happen in the browser —
 * sending through Gmail, and starting the Google OAuth consent flow.
 *
 * Every call attaches a **fresh** Supabase access token. The one exception is
 * `googleConsentUrl`, which is a navigation rather than a fetch and therefore
 * cannot carry a header at all.
 */

const BASE = import.meta.env.VITE_SERVER_URL as string | undefined

if (!BASE) {
  throw new Error(
    "VITE_SERVER_URL is not set in frontend/.env — the app cannot reach the " +
      "Express server, so nothing can send. See .env.example."
  )
}

/**
 * A failed request, carrying the server's machine-readable `code`.
 *
 * The code is the point: `errors.ts` on the server deliberately answers state
 * problems with 409 and a stable code (`no_account`, `needs_reauth`,
 * `empty_step`), and the UI branches on those to offer the right next action
 * rather than showing one generic "something went wrong".
 */
export class ApiError extends Error {
  /*
   * Fields declared and assigned separately rather than as constructor parameter
   * properties: `erasableSyntaxOnly` is on, and parameter properties emit real
   * code, so they aren't erasable type syntax.
   */
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

/** The `{ error, code }` body every `HttpError` is serialised into. */
function messageFrom(body: unknown, status: number): { message: string; code: string } {
  if (body && typeof body === "object") {
    const shape = body as { error?: unknown; code?: unknown }
    if (typeof shape.error === "string") {
      return {
        message: shape.error,
        code: typeof shape.code === "string" ? shape.code : "unknown",
      }
    }
  }

  return { message: `Request failed (${status}).`, code: "unknown" }
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" }
): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch {
    /*
     * `fetch` rejects only for network-level failures, and in development that is
     * almost always the same thing: the Express server isn't running. Say so,
     * because the browser's own message ("Failed to fetch") names nothing.
     */
    throw new ApiError(
      0,
      `Can't reach the server at ${BASE}. Is it running (\`npm run dev\` in server/)?`,
      "network"
    )
  }

  // 204 has no body to parse; `.json()` on one throws.
  if (response.status === 204) return undefined as T

  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const { message, code } = messageFrom(body, response.status)
    throw new ApiError(response.status, message, code)
  }

  return body as T
}

/**
 * Where to send the browser to begin Google consent.
 *
 * A full navigation, not a fetch: the server answers with a 302 to Google's
 * consent screen, and a `fetch` would follow that redirect in the background
 * where the user can't see or interact with it. The token goes in the query
 * string because a navigation carries no headers — see the note on the server's
 * `/api/auth/google` route.
 */
export async function googleConsentUrl(): Promise<string> {
  return `${BASE}/api/auth/google?token=${encodeURIComponent(await accessToken())}`
}

export interface TestSendResult {
  sent: true
  to: string
  subject: string
  from: string
  attachments: string[]
  gmailMessageId: string
}

/**
 * Send one step to one address immediately.
 *
 * `stepId` must be a real `sequence_steps` or `template_steps` UUID — the server
 * re-reads the step from the database rather than trusting content from the
 * request, so **unsaved editor changes are not in the email**. Callers must
 * persist before calling this.
 */
export async function sendTest(input: {
  stepId: string
  to: string
  leadId?: string | undefined
}): Promise<TestSendResult> {
  return request<TestSendResult>("/api/test-send", { method: "POST", body: input })
}

export async function disconnectAccount(id: string): Promise<void> {
  await request<{ disconnected: true }>(`/api/accounts/${id}/disconnect`, {
    method: "POST",
  })
}

export interface LaunchResult {
  leadId: string
  /**
   * True when this step was already queued — a double-clicked Launch, or a
   * relaunch. Not an error: the server reports the existing schedule rather than
   * creating a second row, because that would be a duplicate email.
   */
  alreadyQueued: boolean
  /** The real UTC instant the scheduler will send at, not the IST string typed in. */
  scheduledAt: string
  /**
   * The **send** row's status (`pending`, …) — not the lead's, which becomes
   * `scheduled`. Named loosely on purpose: feeding this to a lead's status field
   * would be a category error, and `SendStatus` here would invite exactly that.
   */
  status: string
  sendTimeIST?: string
  from?: string
}

/**
 * Queue a lead's opening email.
 *
 * The server validates everything that would otherwise fail silently three days
 * later — already replied, already launched, no sequence, no email step, empty
 * subject, empty body, no or ambiguous Gmail account — and answers with a 409 and a
 * stable `code` for each. Those messages are written to be shown as-is.
 */
export async function launchLead(leadId: string): Promise<LaunchResult> {
  return request<LaunchResult>(`/api/leads/${leadId}/launch`, {
    method: "POST",
    // No `gmailAccountId`: there is normally one connected account, and the server
    // answers `ambiguous_account` rather than guessing when there are several.
    body: {},
  })
}

export interface CancelResult {
  leadId: string
  /** How many pending sends were cancelled. */
  cancelled: number
  /**
   * Where the **lead** landed — `draft` only if nothing has actually gone out. A
   * lead whose opening email is already in someone's inbox comes back `sent`,
   * because showing it as a draft would invite a relaunch the idempotency index
   * then silently refuses.
   */
  status: LeadStatus
}

export async function cancelLead(leadId: string): Promise<CancelResult> {
  return request<CancelResult>(`/api/leads/${leadId}/cancel`, { method: "POST" })
}
