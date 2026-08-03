import { Router } from "express"
import {
  completeConsent,
  failureRedirect,
  startConsent,
  successRedirect,
  disconnectAccount,
} from "../auth/google.ts"
import { currentUser, requireUser } from "../auth/requireUser.ts"
import { db } from "../db.ts"
import { listAccountsForUser } from "../email/accounts.ts"
import { route } from "../http/handler.ts"
import { idParamsSchema, oauthCallbackSchema, type IdParams, type OAuthCallbackQuery } from "../http/schemas.ts"
import { HttpError } from "../http/errors.ts"
import { loggerFor } from "../logger.ts"

/**
 * The Google connect endpoints.
 *
 * `GET /api/auth/google` and its callback are **browser navigations**, not fetch
 * calls: the user is bounced to Google and back. That has two consequences the
 * rest of the API doesn't have —
 *
 *  - the callback cannot require an `Authorization` header, because a redirect
 *    carries none. The signed `state` is what identifies the user instead.
 *  - failures redirect to the frontend with an `?error=` rather than returning
 *    JSON, since the browser is showing whatever this responds with.
 */

const log = loggerFor("routes/auth")

export const authRouter = Router()

/**
 * Start consent.
 *
 * Authenticated with `?token=` rather than a header, again because this is a
 * navigation. The token is a short-lived Supabase access token and it never
 * leaves the user's own machine except to Supabase itself, but it does land in
 * this server's access log — which is why the redirect to Google happens
 * immediately and nothing else on this route touches it.
 */
authRouter.get(
  "/google",
  route({}, async ({ req, res }) => {
    const token = typeof req.query.token === "string" ? req.query.token : undefined

    if (!token) {
      res.redirect(failureRedirect("Missing session token — sign in and try again."))
      return
    }

    try {
      const user = await verifyToken(token)
      res.redirect(await startConsent(user.id))
    } catch (error) {
      log.warn({ err: error }, "Could not start Google consent")
      res.redirect(failureRedirect(messageFor(error)))
    }
  })
)

/** Google's redirect back. Always ends in a redirect to the frontend. */
authRouter.get(
  "/google/callback",
  route<unknown, unknown, OAuthCallbackQuery>({ query: oauthCallbackSchema }, async ({ query, res }) => {
    // The user clicked Cancel, or Google refused. `access_denied` is the normal
    // one and deserves a readable message rather than a raw error code.
    if (query.error) {
      const reason =
        query.error === "access_denied"
          ? "You cancelled the Google authorization."
          : `Google returned an error: ${query.error}`
      res.redirect(failureRedirect(reason))
      return
    }

    if (!query.code || !query.state) {
      res.redirect(failureRedirect("Google's response was missing the authorization code."))
      return
    }

    try {
      const account = await completeConsent(query.code, query.state)
      res.redirect(`${successRedirect}&email=${encodeURIComponent(account.email)}`)
    } catch (error) {
      log.error({ err: error }, "Google consent failed")
      res.redirect(failureRedirect(messageFor(error)))
    }
  })
)

export const accountsRouter = Router()

accountsRouter.use(requireUser)

/**
 * The connected accounts as the server sees them.
 *
 * The frontend normally reads `gmail_accounts_public` straight from Supabase;
 * this exists so the Settings page can confirm a just-completed connect without
 * waiting on a refetch race with the redirect.
 */
accountsRouter.get(
  "/",
  route({}, async ({ req }) => {
    const user = currentUser(req)
    const accounts = await listAccountsForUser(user.id)

    // Explicitly projected, never spread: `refresh_token_enc` lives on these rows
    // and a `...account` here would put it in an HTTP response.
    return {
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
        name: account.display_name ?? account.email,
        dailyLimit: account.daily_limit,
        followUpSharePct: account.follow_up_share_pct,
        status: account.status,
      })),
    }
  })
)

accountsRouter.post(
  "/:id/disconnect",
  route<unknown, IdParams>({ params: idParamsSchema }, async ({ params, req }) => {
    const user = currentUser(req)
    await disconnectAccount(params.id, user.id)
    return { disconnected: true }
  })
)

/** `db.auth.getUser` behind a narrower signature, for the query-token path. */
async function verifyToken(token: string): Promise<{ id: string }> {
  const { data, error } = await db.auth.getUser(token)

  if (error || !data.user) {
    throw new Error("Session expired or invalid — sign in again.")
  }

  return { id: data.user.id }
}

/** A message safe to put in a URL the user will read. */
function messageFor(error: unknown): string {
  if (error instanceof HttpError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong connecting your Gmail account."
}
