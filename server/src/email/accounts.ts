import { google } from "googleapis"
import type { OAuth2Client } from "google-auth-library"
import { GmailMailer } from "./gmail-mailer.ts"
import { ReplyWatcher } from "./reply-watcher.ts"
import { decrypt, DecryptionError, encrypt } from "../crypto.ts"
import { db, unwrap, unwrapMany, type GmailAccountRow } from "../db.ts"
import { env } from "../env.ts"
import { loggerFor } from "../logger.ts"

/**
 * Everything to do with a *connected account's credentials*: building an
 * authorized client, keeping the refreshed tokens in the database, and marking
 * an account dead when its refresh token stops working.
 *
 * The OAuth client is cached per account because `google-auth-library` refreshes
 * the access token itself and emits `tokens` when it does — that event is the
 * only chance to persist the new value, and a fresh client per request would
 * throw away both the cached token and the listener.
 */

const log = loggerFor("accounts")

/** The Gmail scopes this tool asks for. Sending plus reply detection, nothing else. */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  // Send only — one tier less alarming on the consent screen than gmail.compose,
  // and drafts are never created.
  "https://www.googleapis.com/auth/gmail.send",
  // Restricted scope, needed to see whether a thread has an inbound reply.
  "https://www.googleapis.com/auth/gmail.readonly",
] as const

/** An account whose stored refresh token no longer works. */
export class AccountNeedsReauthError extends Error {
  override readonly name = "AccountNeedsReauthError"

  constructor(readonly accountId: string, message: string) {
    super(message)
  }
}

const clients = new Map<string, OAuth2Client>()

/** A bare OAuth2 client with no credentials — for the consent + code exchange. */
export function newOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  )
}

/**
 * An OAuth client bound to one stored account, with its tokens loaded.
 *
 * Throws `AccountNeedsReauthError` when the ciphertext will not decrypt (a
 * rotated `TOKEN_ENCRYPTION_KEY`, a corrupted row): the account is unusable and
 * the caller must surface a Reconnect prompt rather than attempt a send.
 */
export function oauthClientFor(account: GmailAccountRow): OAuth2Client {
  const cached = clients.get(account.id)
  if (cached) return cached

  const client = newOAuthClient()

  let refreshToken: string
  try {
    refreshToken = decrypt(account.refresh_token_enc)
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new AccountNeedsReauthError(
        account.id,
        `Stored refresh token for ${account.email} could not be decrypted.`
      )
    }
    throw error
  }

  // Conditional spread throughout: with exactOptionalPropertyTypes an explicit
  // `access_token: undefined` is a type error, and it would also make the
  // library believe it has a token when it does not.
  const cachedAccessToken = account.access_token_enc
    ? safeDecrypt(account.access_token_enc, account.email)
    : undefined

  client.setCredentials({
    refresh_token: refreshToken,
    ...(cachedAccessToken ? { access_token: cachedAccessToken } : {}),
    ...(account.access_token_expires_at
      ? { expiry_date: Date.parse(account.access_token_expires_at) }
      : {}),
  })

  /*
   * Persist refreshed access tokens so a restart does not force a new refresh
   * round trip, and capture a rotated refresh token if Google ever issues one.
   * Fire-and-forget by necessity — the event is synchronous — so failures are
   * logged and swallowed: a token that fails to persist still works in memory.
   */
  client.on("tokens", (tokens) => {
    void persistTokens(account.id, tokens).catch((error: unknown) => {
      log.warn({ err: error, accountId: account.id }, "Could not persist refreshed tokens")
    })
  })

  clients.set(account.id, client)
  return client
}

/**
 * A cached access token that will not decrypt is merely a lost optimisation —
 * the refresh token (already verified above) can mint a new one — so this
 * degrades to "no cached token" instead of failing the account.
 */
function safeDecrypt(ciphertext: string, email: string): string | undefined {
  try {
    return decrypt(ciphertext)
  } catch {
    log.warn({ email }, "Cached access token could not be decrypted; refreshing instead")
    return undefined
  }
}

async function persistTokens(
  accountId: string,
  tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }
): Promise<void> {
  await unwrap(
    "persist refreshed Google tokens",
    db
      .from("gmail_accounts")
      .update({
        ...(tokens.access_token
          ? {
              access_token_enc: encrypt(tokens.access_token),
              access_token_expires_at: tokens.expiry_date
                ? new Date(tokens.expiry_date).toISOString()
                : null,
            }
          : {}),
        ...(tokens.refresh_token ? { refresh_token_enc: encrypt(tokens.refresh_token) } : {}),
        // A successful refresh proves the credentials are live again, which is
        // what lets an account recover from needs_reauth without a manual step.
        status: "active",
      })
      .eq("id", accountId)
      .select("id")
  )
}

/** A mailer bound to one connected Gmail account. */
export function mailerFor(account: GmailAccountRow): GmailMailer {
  return new GmailMailer(
    account.email,
    account.display_name ?? account.email,
    oauthClientFor(account)
  )
}

/** A reply watcher bound to one connected Gmail account. */
export function replyWatcherFor(account: GmailAccountRow): ReplyWatcher {
  return new ReplyWatcher(oauthClientFor(account), account.email)
}

/** Drop cached credentials after a disconnect or a re-authorization. */
export function forgetAccount(accountId: string): void {
  clients.delete(accountId)
}

/**
 * Flag an account as unusable so the UI can show Reconnect.
 *
 * Called from the scheduler on `GmailAuthError`. The cached client is dropped
 * too, otherwise the next tick would keep using the same dead refresh token from
 * memory and never notice the reconnect.
 */
export async function markNeedsReauth(accountId: string, reason: string): Promise<void> {
  forgetAccount(accountId)
  log.error({ accountId, reason }, "Gmail account needs re-authorization")

  await unwrap(
    "mark account needs_reauth",
    db.from("gmail_accounts").update({ status: "needs_reauth" }).eq("id", accountId).select("id")
  )
}

/** Every account that can currently send, oldest first. */
export async function listActiveAccounts(): Promise<GmailAccountRow[]> {
  return unwrapMany(
    "list active Gmail accounts",
    db
      .from("gmail_accounts")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: true })
  )
}

/** One account by id, or null. */
export async function findAccount(accountId: string): Promise<GmailAccountRow | null> {
  return unwrap(
    "find Gmail account",
    db.from("gmail_accounts").select("*").eq("id", accountId).maybeSingle()
  )
}

/**
 * Every account belonging to one user, whatever its status.
 *
 * `user_id` scoping is explicit because the secret key bypasses RLS: nothing but
 * this `.eq()` stops one user's routes touching another's accounts.
 */
export async function listAccountsForUser(userId: string): Promise<GmailAccountRow[]> {
  return unwrapMany(
    "list Gmail accounts for user",
    db
      .from("gmail_accounts")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
  )
}
