import { createClient } from "@supabase/supabase-js"
import type { Database } from "@shared/database.types.ts"

/**
 * The browser's one and only database client.
 *
 * Two things about it are load-bearing:
 *
 *  - `createClient<Database>` — without the generic, every `.from("leads")`
 *    returns `any`, and a column typo becomes a blank field in a sent email
 *    rather than a compile error. This is the single line that makes all of
 *    `shared/mappers.ts` actually type-check against the real schema.
 *  - The **publishable** key, never the secret one. Everything the browser can
 *    reach is gated by RLS on `user_id = auth.uid()`, so the key being visible in
 *    the bundle is by design (see CLAUDE.md). `gmail_accounts` has no RLS policy
 *    at all and is therefore simply unreachable from here — the browser reads
 *    connected accounts through the `gmail_accounts_public` view instead.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
  | string
  | undefined

if (!url || !publishableKey) {
  /*
   * Thrown at module load, not tolerated as a `null` client.
   *
   * This used to export `null` when env vars were missing, because the UI ran on
   * mock data and had to boot without a project. Now that the app reads real
   * rows, a null client would surface as an app that renders an empty database
   * and silently drops every write — indistinguishable from "you have no leads".
   * Failing loudly at startup names the actual problem instead.
   */
  throw new Error(
    "Supabase is not configured: set VITE_SUPABASE_URL and " +
      "VITE_SUPABASE_PUBLISHABLE_KEY in frontend/.env (see .env.example), " +
      "then restart `npm run dev` — Vite only reads .env at boot."
  )
}

export const supabase = createClient<Database>(url, publishableKey, {
  auth: {
    /*
     * The session lives in localStorage and is refreshed in the background, so a
     * reload doesn't sign the user out. Single-user internal tool on one browser
     * — there's no shared-machine risk to trade off against.
     */
    persistSession: true,
    autoRefreshToken: true,
    /*
     * Nothing in this app arrives via an auth redirect: sign-in is email +
     * password, and the Google OAuth callback is handled entirely by the Express
     * server. Leaving detection on makes supabase-js parse every page load's URL
     * hash looking for tokens it will never find.
     */
    detectSessionInUrl: false,
  },
})

/**
 * The access token for calls to our own Express server.
 *
 * Returned fresh from `getSession()` on each call rather than captured once:
 * these tokens expire in an hour, and a stale one turns into a confusing 401
 * from an endpoint that was working ten minutes ago.
 */
export async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error

  const token = data.session?.access_token
  if (!token) throw new Error("Not signed in.")

  return token
}

/**
 * The signed-in user's id.
 *
 * Needed despite RLS already scoping every query to `auth.uid()`: PostgREST
 * refuses an UPDATE or DELETE with no filter at all (`21000: UPDATE requires a
 * WHERE clause`), as a guard against a forgotten `.eq()` rewriting the whole
 * table. For rows keyed by anything else that filter is the row's own id; the
 * `settings` table's primary key *is* `user_id`, so it needs this.
 */
export async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error

  const id = data.session?.user.id
  if (!id) throw new Error("Not signed in.")

  return id
}
