import { google } from "googleapis"
import type { OAuth2Client } from "google-auth-library"
import { z } from "zod"
import { decrypt, encrypt, randomToken, sign, verify } from "../crypto.ts"
import { db, unwrap, unwrapMany, unwrapRequired, type GmailAccountRow } from "../db.ts"
import { env } from "../env.ts"
import { forgetAccount, GOOGLE_SCOPES, newOAuthClient } from "../email/accounts.ts"
import { BadRequestError, ConflictError, UnauthorizedError } from "../http/errors.ts"
import { loggerFor } from "../logger.ts"

/**
 * The Google connect flow: consent → code exchange → an encrypted refresh token
 * in `gmail_accounts`.
 *
 * Two things here are non-negotiable and easy to get wrong:
 *
 *  - `access_type=offline` **with** `prompt=consent`. Without offline there is no
 *    refresh token at all; without the forced consent Google returns one only on
 *    the *first* authorization ever granted, so a reconnect after revoking would
 *    silently produce an account that can send for an hour and then dies.
 *  - The consent screen must be **published to production**. Left in Testing
 *    mode, Google expires refresh tokens after 7 days and the scheduler stops
 *    every week with `invalid_grant`.
 */

const log = loggerFor("google-oauth")

/** How long a consent round trip may take before its `state` is refused. */
const STATE_TTL_MINUTES = 10

/**
 * Google's `userinfo` response — a third-party JSON body, so it is parsed rather
 * than trusted. `sub` and `email` both being present is what the rest of this
 * file assumes; a missing `email` would otherwise reach the unique index as null.
 */
const userInfoSchema = z.object({
  id: z.string().min(1, "Google returned no account id (sub)"),
  email: z.string().min(1, "Google returned no email address").toLowerCase(),
  name: z.string().optional(),
})

/**
 * The `state` parameter, which has to survive a round trip through Google and
 * come back naming the user who started it.
 *
 * `oauth_states` has no `user_id` column, so the id travels inside the state
 * itself: `base64url(userId).nonce.hmac`. The HMAC is what makes that safe —
 * without it, anyone could hand us a state naming *another* user and attach their
 * own Gmail to that account. The nonce row is still written to the table, because
 * a signature alone would be replayable forever; deleting it on use is what makes
 * the state single-use.
 */
function buildState(userId: string): string {
  const nonce = randomToken(24)
  const encodedUser = Buffer.from(userId, "utf8").toString("base64url")
  const payload = `${encodedUser}.${nonce}`
  return `${payload}.${sign(payload)}`
}

function parseState(state: string): { userId: string } {
  const parts = state.split(".")

  if (parts.length !== 3) {
    throw new BadRequestError("Malformed OAuth state.")
  }

  const [encodedUser, nonce, signature] = parts

  if (!encodedUser || !nonce || !signature) {
    throw new BadRequestError("Malformed OAuth state.")
  }
  if (!verify(`${encodedUser}.${nonce}`, signature)) {
    throw new BadRequestError("OAuth state signature does not match.")
  }

  const userId = Buffer.from(encodedUser, "base64url").toString("utf8")

  if (!z.uuid().safeParse(userId).success) {
    throw new BadRequestError("OAuth state does not contain a valid user id.")
  }

  return { userId }
}

/** Record the state so it can be used exactly once. */
export async function startConsent(userId: string): Promise<string> {
  const state = buildState(userId)

  await unwrap(
    "store oauth state",
    db
      .from("oauth_states")
      .insert({
        state,
        expires_at: new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000).toISOString(),
      })
      .select("state")
  )

  return newOAuthClient().generateAuthUrl({
    // Both are required for a refresh token — see the note at the top of the file.
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SCOPES],
    include_granted_scopes: true,
    state,
  })
}

/**
 * Verify and burn the state, returning who started the flow.
 *
 * The delete is the CSRF check: a state that is not in the table was either never
 * issued, already used, or has expired, and all three must be refused.
 */
async function consumeState(state: string): Promise<string> {
  const { userId } = parseState(state)

  const deleted = await unwrapMany(
    "consume oauth state",
    db.from("oauth_states").delete().eq("state", state).select("state, expires_at")
  )

  const row = deleted[0]

  if (!row) {
    throw new BadRequestError("This OAuth state is unknown or has already been used.")
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new BadRequestError("This consent link has expired — start again.")
  }

  return userId
}

export interface ConnectedAccount {
  id: string
  email: string
  displayName: string
  /** True when this replaced the credentials of an already-connected address. */
  reconnected: boolean
}

/**
 * Exchange the authorization code and store the account.
 *
 * The refresh token is encrypted before it touches the database, and it is the
 * one value that must never appear anywhere else — not in a log line, not in a
 * response body, not in the `gmail_accounts_public` view.
 */
export async function completeConsent(code: string, state: string): Promise<ConnectedAccount> {
  const userId = await consumeState(state)

  const client = newOAuthClient()
  const { tokens } = await client.getToken(code)

  if (!tokens.refresh_token) {
    /*
     * Reachable when the user has authorized this Cloud project before and
     * Google decides not to re-issue. Refusing loudly is right: an account
     * stored without a refresh token works until the access token expires an
     * hour later and then fails every send with no obvious cause.
     */
    throw new ConflictError(
      "Google did not return a refresh token. Remove this app at " +
        "myaccount.google.com/permissions and connect again.",
      "no_refresh_token"
    )
  }

  client.setCredentials(tokens)

  const profile = await fetchUserInfo(client)
  const grantedScopes = tokens.scope?.split(" ") ?? [...GOOGLE_SCOPES]

  const existing = await findByEmail(userId, profile.email)

  const columns = {
    email: profile.email,
    display_name: profile.name ?? profile.email,
    google_sub: profile.id,
    refresh_token_enc: encrypt(tokens.refresh_token),
    scopes: grantedScopes,
    // A fresh grant clears `needs_reauth` — that is the whole point of the
    // Reconnect button.
    status: "active" as const,
    ...(tokens.access_token
      ? {
          access_token_enc: encrypt(tokens.access_token),
          access_token_expires_at: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : null,
        }
      : {}),
  }

  /*
   * Update-or-insert by hand rather than `.upsert()`: the uniqueness constraint is
   * an expression index on `(user_id, lower(email))`, and PostgREST's
   * `on_conflict` can only name plain columns, so an upsert would raise 42P10.
   */
  const account = existing
    ? await unwrapRequired(
        "update connected Gmail account",
        db.from("gmail_accounts").update(columns).eq("id", existing.id).select("*").single()
      )
    : await unwrapRequired(
        "insert connected Gmail account",
        db
          .from("gmail_accounts")
          .insert({ ...columns, user_id: userId })
          .select("*")
          .single()
      )

  // The cached OAuth client still holds the previous (possibly dead) token.
  forgetAccount(account.id)

  log.info(
    { accountId: account.id, email: account.email, reconnected: Boolean(existing) },
    "Gmail account connected"
  )

  return {
    id: account.id,
    email: account.email,
    displayName: account.display_name ?? account.email,
    reconnected: Boolean(existing),
  }
}

async function fetchUserInfo(client: OAuth2Client): Promise<z.infer<typeof userInfoSchema>> {
  const oauth2 = google.oauth2({ version: "v2", auth: client })
  const response = await oauth2.userinfo.get()

  const parsed = userInfoSchema.safeParse(response.data)

  if (!parsed.success) {
    throw new ConflictError(
      `Google's profile response was unusable: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
      "bad_userinfo"
    )
  }

  return parsed.data
}

async function findByEmail(userId: string, email: string): Promise<GmailAccountRow | null> {
  return unwrap(
    "find Gmail account by email",
    db
      .from("gmail_accounts")
      .select("*")
      // ilike, not eq: the unique index is on `lower(email)`, so "A@b.com" and
      // "a@b.com" are the same row and an `eq` would miss it and then 23505.
      .ilike("email", email)
      .eq("user_id", userId)
      .maybeSingle()
  )
}

/**
 * Revoke at Google, then remove locally.
 *
 * That order matters: removing first would lose the only copy of the refresh
 * token and leave the grant live in the user's Google account forever. A failed
 * revoke is logged and the removal proceeds — an unusable local row is worse than
 * a stale grant the user can remove themselves.
 *
 * ## Why an account that has sent anything is retired rather than deleted
 *
 * `sends.gmail_account_id` is `NOT NULL` with an `ON DELETE NO ACTION` foreign
 * key, so a DELETE here raises 23503 the moment one email has gone out — and it
 * should. That column is not decoration: it records which mailbox a message came
 * from, and it is what pins the rest of the lead's sequence to the same thread. A
 * cascade would erase delivery history; a SET NULL would strip the pin off live
 * sequences and let their follow-ups be sent from somewhere else.
 *
 * So an account with history is marked `revoked` and has its tokens cleared
 * instead. That is the same outcome the user asked for — the credentials are gone
 * at Google and locally, and nothing can send from it — while `sends` keeps
 * pointing at a row that can still name the mailbox. A lead mid-sequence on it
 * then reports "reconnect this account" (see `pickAccountForLead`) rather than
 * silently continuing from a different sender.
 *
 * An account that never sent anything is deleted outright, so a mistyped
 * connection leaves nothing behind.
 *
 * A retired row is fully revived by connecting the same address again:
 * `completeConsent` matches it on email and writes a fresh token with
 * `status: 'active'`, which is the same path the Reconnect button uses.
 */
export async function disconnectAccount(accountId: string, userId: string): Promise<void> {
  const account = await unwrap(
    "find account to disconnect",
    db
      .from("gmail_accounts")
      .select("*")
      .eq("id", accountId)
      .eq("user_id", userId)
      .maybeSingle()
  )

  if (!account) {
    throw new UnauthorizedError("No such connected account.")
  }

  try {
    const client = newOAuthClient()
    await client.revokeToken(decryptForRevoke(account))
  } catch (error) {
    log.warn({ err: error, accountId }, "Could not revoke the Google token; removing anyway")
  }

  // Drop the cached OAuth client first, so nothing in flight can keep sending
  // from this account between the revoke and the write.
  forgetAccount(accountId)

  const used = await hasSends(accountId)

  if (used) {
    await unwrap(
      "retire Gmail account",
      db
        .from("gmail_accounts")
        .update({
          status: "revoked",
          /*
           * The token is already dead at Google; this is so it is not sitting in
           * the database either. Emptied rather than nulled because the column is
           * `NOT NULL` — and an empty string cannot decrypt, so any code path that
           * tried to use it would fail loudly rather than send.
           */
          refresh_token_enc: "",
          access_token_enc: null,
          access_token_expires_at: null,
        })
        .eq("id", accountId)
        .eq("user_id", userId)
        .select("id")
    )

    log.info({ accountId, email: account.email }, "Gmail account retired (has send history)")
    return
  }

  await unwrap(
    "delete Gmail account",
    db.from("gmail_accounts").delete().eq("id", accountId).select("id")
  )

  log.info({ accountId, email: account.email }, "Gmail account disconnected")
}

/** Has this account ever been recorded as the sender of a queued or delivered email? */
async function hasSends(accountId: string): Promise<boolean> {
  const rows = await unwrapMany(
    "check for sends on account",
    db.from("sends").select("id").eq("gmail_account_id", accountId).limit(1)
  )

  return rows.length > 0
}

/**
 * A refresh token that will not decrypt still has to be deleted, so the failure
 * is swallowed here rather than aborting the disconnect. Returns a placeholder
 * that Google will simply reject — the local row is what actually matters.
 */
function decryptForRevoke(account: GmailAccountRow): string {
  try {
    return decrypt(account.refresh_token_enc)
  } catch {
    return "invalid"
  }
}

/** The URL the "Add account" / Reconnect button navigates to. */
export const successRedirect = `${env.FRONTEND_URL}/settings?connected=1`

/** Where the callback sends the browser when consent fails or is cancelled. */
export function failureRedirect(reason: string): string {
  return `${env.FRONTEND_URL}/settings?error=${encodeURIComponent(reason)}`
}
