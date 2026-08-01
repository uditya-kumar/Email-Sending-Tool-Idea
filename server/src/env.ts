import { config } from "dotenv"
import { z } from "zod"

/**
 * The **only** file in the server that reads `process.env`.
 *
 * Everything is zod-parsed at import time, so a missing secret or a malformed
 * URL is a boot failure naming the exact field — not a 3am `undefined` in the
 * middle of a send. This is the first of the three genuine trust boundaries
 * where types are erased and parsing is mandatory (the others are Express
 * request bodies and Gmail API responses).
 */

config()

/** An origin with no trailing slash, so `${url}/settings` never doubles up. */
const origin = z
  .url()
  .transform((value) => value.replace(/\/+$/, ""))

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // ── Supabase ─────────────────────────────────────────────────────────────
  SUPABASE_URL: z.url(),
  /**
   * `sb_secret_…` (or a legacy `service_role` JWT). Bypasses RLS entirely, so
   * the length floor is a guard against a truncated paste rather than real
   * validation.
   */
  SUPABASE_SECRET_KEY: z.string().min(20),

  // ── Google OAuth ─────────────────────────────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  /**
   * Must match one of the client's Authorized redirect URIs **byte for byte**,
   * including the scheme and any port — Google compares it as a literal string
   * and a mismatch fails the code exchange with `redirect_uri_mismatch`.
   */
  GOOGLE_REDIRECT_URI: z.url(),

  // ── Secrets ──────────────────────────────────────────────────────────────
  /**
   * AES-256-GCM key for the stored refresh token. Asserted to decode to exactly
   * 32 bytes here rather than inside `crypto.ts`, so a wrong-length key can
   * never reach a live encrypt call.
   */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((value) => decodeBase64Length(value) === 32, {
      message:
        "must be exactly 32 bytes, base64-encoded — generate with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    }),
  TRACKING_HMAC_SECRET: z.string().min(16),

  // ── URLs ─────────────────────────────────────────────────────────────────
  /** Where pixel and click links point. A tunnel URL while testing tracking. */
  TRACKING_BASE_URL: origin,
  /** CORS origin *and* the OAuth success redirect target. */
  FRONTEND_URL: origin,

  // ── Scheduler ────────────────────────────────────────────────────────────
  /** Off when an external pinger drives `POST /api/cron/tick` instead. */
  SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /**
   * Guards `POST /api/cron/tick`. Optional: with no value set that route is
   * disabled outright rather than left open, so forgetting it fails closed.
   */
  CRON_SECRET: z.string().min(16).optional(),
})

/** Byte length of a base64 string, or -1 when it isn't valid base64. */
function decodeBase64Length(value: string): number {
  try {
    return Buffer.from(value, "base64").length
  } catch {
    return -1
  }
}

/**
 * A blank line in `.env` means "not set", not "set to empty string".
 *
 * dotenv assigns `CRON_SECRET=""` for a bare `CRON_SECRET=`, and an empty string
 * is *present* as far as zod is concerned — so `.optional()` would not apply and
 * `.min(16)` would fail. A freshly copied `.env.example` would then refuse to
 * boot on the fields the user was correctly leaving alone. Stripping the empties
 * first also makes a required-but-blank field report "Required" naming itself,
 * instead of a confusing "too small".
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") result[key] = value
  }

  return result
}

const parsed = schema.safeParse(withoutBlanks(process.env))

if (!parsed.success) {
  // Written straight to stderr rather than through the logger: the logger reads
  // `env` itself, and a config error must be legible even if nothing else works.
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")

  process.stderr.write(
    `\nInvalid server environment — see server/.env.example:\n${issues}\n\n`
  )
  process.exit(1)
}

export const env = Object.freeze(parsed.data)

export type Env = typeof env

/** True in production, where the unverified-app OAuth warning is expected. */
export const isProduction = env.NODE_ENV === "production"
