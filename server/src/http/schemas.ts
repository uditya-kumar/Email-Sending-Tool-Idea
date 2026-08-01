import { z } from "zod"
import { LEAD_EMAIL_PATTERN } from "../../../shared/leads.ts"
import { isValidIST } from "../../../shared/time.ts"

/**
 * Reusable request-body pieces. Kept together so "what a valid email looks
 * like" has exactly one definition on the server, matching the CHECK constraint
 * in `schema.sql`.
 */

/**
 * Matches the `leads.email` CHECK constraint, so a parse success can't 23514.
 *
 * The pattern itself lives in `shared/leads.ts` because the browser validates the
 * same thing in two more places (the lead dialog and the CSV importer) and three
 * hand-copied regexes had already drifted apart once.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(LEAD_EMAIL_PATTERN, "must be a valid email address")

export const uuidSchema = z.uuid()

/** "HH:mm" in IST, validated with the same helper the frontend uses. */
export const istTimeSchema = z
  .string()
  .refine(isValidIST, 'must be a 24-hour "HH:mm" time, e.g. "09:30"')

/** `{ id }` for the many `/api/…/:id` routes. */
export const idParamsSchema = z.object({ id: uuidSchema })

export type IdParams = z.infer<typeof idParamsSchema>

/** `POST /api/test-send` — sends real mail from a browser-supplied payload. */
export const testSendSchema = z.object({
  /**
   * The step being edited. Either a `sequence_steps` row (compose flow) or a
   * `template_steps` row (Templates page) — which one is resolved server-side,
   * because the frontend genuinely doesn't know which table it came from in the
   * shared editor component.
   */
  stepId: uuidSchema,
  to: emailSchema,
  /**
   * Whose data to merge into the tags. Omitted from the Templates page, where
   * there is no recipient — the renderer then falls back to each tag's own
   * fallback value, which is exactly what the preview shows.
   */
  leadId: uuidSchema.optional(),
})

export type TestSendBody = z.infer<typeof testSendSchema>

/** `POST /api/leads/:id/launch` */
export const launchSchema = z.object({
  /**
   * Which connected Gmail to send from. Optional because there is normally one:
   * omitted means "the only active account", and having several without saying
   * which is a 409 rather than an arbitrary pick.
   */
  gmailAccountId: uuidSchema.optional(),
})

export type LaunchBody = z.infer<typeof launchSchema>

/**
 * `GET /t/c/:trackingId` — the path parameter.
 *
 * Only the click route validates its id through zod. The open pixel deliberately
 * does not: a schema failure there would answer a mail client with a JSON 400
 * instead of an image, so it checks the shape by hand and returns the GIF either
 * way.
 */
export const trackingParamsSchema = z.object({ trackingId: uuidSchema })

export type TrackingParams = z.infer<typeof trackingParamsSchema>

/** `GET /t/c/:trackingId` — the click redirect's query string. */
export const clickQuerySchema = z.object({
  /** base64url of the original destination URL. */
  u: z.string().min(1),
  /** HMAC over `u`, without which this endpoint is an open redirect. */
  s: z.string().min(1),
})

export type ClickQuery = z.infer<typeof clickQuerySchema>

/** `GET /api/auth/google/callback` — Google's redirect back to us. */
export const oauthCallbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  /** Present instead of `code` when the user clicks Cancel on the consent screen. */
  error: z.string().optional(),
})

export type OAuthCallbackQuery = z.infer<typeof oauthCallbackSchema>
