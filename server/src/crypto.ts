import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { env } from "./env.ts"

/**
 * Two independent primitives, deliberately keyed separately:
 *
 * - `encrypt`/`decrypt` (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`) protect the Gmail
 *   refresh token **at rest** in `gmail_accounts`. A leaked database dump is
 *   then not a leaked mailbox.
 * - `sign`/`verify` (HMAC-SHA256, `TRACKING_HMAC_SECRET`) authenticate values
 *   that travel through a **recipient's mail client** and come back as URL
 *   parameters — the click-redirect target and the OAuth `state`. Without a
 *   signature the click endpoint is an open redirect for spammers.
 */

const ALGORITHM = "aes-256-gcm"
/** 96 bits is the GCM-recommended IV size and what Node's GCM is optimised for. */
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

const KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64")

/** Ciphertext that has been tampered with, truncated, or made with another key. */
export class DecryptionError extends Error {
  override readonly name = "DecryptionError"
}

/**
 * Encrypt a secret for storage in a text column.
 *
 * Layout: `base64(iv ‖ authTag ‖ ciphertext)`. The IV and tag are prefixed
 * rather than stored in separate columns so the whole thing round-trips through
 * one `text` field and can never be half-migrated.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, KEY, iv)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")
}

/**
 * Reverse `encrypt`. Throws `DecryptionError` rather than returning null: a
 * refresh token that will not decrypt is an unrecoverable account, and the
 * caller must mark it `needs_reauth` instead of sending with `undefined`.
 */
export function decrypt(encoded: string): string {
  const raw = Buffer.from(encoded, "base64")

  if (raw.length <= IV_BYTES + AUTH_TAG_BYTES) {
    throw new DecryptionError("Ciphertext is too short to contain an IV and auth tag.")
  }

  const iv = raw.subarray(0, IV_BYTES)
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES)
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES)

  try {
    const decipher = createDecipheriv(ALGORITHM, KEY, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  } catch (cause) {
    // GCM's final() is what fails on a wrong key or altered ciphertext. The
    // original message ("unable to authenticate data") says nothing useful.
    throw new DecryptionError(
      "Could not decrypt — wrong TOKEN_ENCRYPTION_KEY or corrupted ciphertext.",
      { cause }
    )
  }
}

/** URL-safe HMAC-SHA256 of `payload`, truncated to 32 chars (128 bits). */
export function sign(payload: string): string {
  return createHmac("sha256", env.TRACKING_HMAC_SECRET)
    .update(payload)
    .digest("base64url")
    .slice(0, 32)
}

/**
 * Constant-time signature check.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — and the early return is safe because a signature's length is public.
 */
export function verify(payload: string, signature: string): boolean {
  const expected = Buffer.from(sign(payload))
  const actual = Buffer.from(signature)

  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** An unguessable opaque token, for the OAuth `state` parameter. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

/**
 * Constant-time comparison of two secrets that are not HMACs — the cron secret
 * and the stored OAuth `state`.
 *
 * A plain `===` on these leaks their prefix through response timing, which is
 * enough to guess a shared secret one character at a time.
 */
export function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)

  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
