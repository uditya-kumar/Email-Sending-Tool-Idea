import type { Session } from "@supabase/supabase-js"
import { useEffect, useState } from "react"
import { supabase } from "./supabase"
import type { UserProfile } from "./types"

/**
 * Sign-in state for the one user this tool has.
 *
 * Email + password rather than a magic link, which the plan originally called
 * for. Supabase's built-in mailer is rate-limited to a couple of messages an
 * hour on the free tier and only delivers to project-team addresses — enough to
 * lock yourself out during a normal afternoon of development. With signups
 * disabled in the dashboard and the account created by hand, a password gives up
 * nothing here.
 */

/** What `useAuth` reports while the stored session is being restored. */
export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: Session; profile: UserProfile }

/**
 * The display name shown in the header.
 *
 * Supabase puts nothing in `user_metadata` for a dashboard-created user, so the
 * local part of the email is the fallback: "uditya204@gmail.com" → "Uditya204".
 * Better than rendering an empty string, and the Profile dialog can overwrite it.
 */
function profileFrom(session: Session): UserProfile {
  const email = session.user.email ?? ""
  const metadata = session.user.user_metadata as { name?: unknown }
  const name = typeof metadata.name === "string" ? metadata.name.trim() : ""

  if (name) return { name, email }

  const localPart = email.split("@")[0] ?? ""
  return {
    name: localPart ? localPart.charAt(0).toUpperCase() + localPart.slice(1) : "You",
    email,
  }
}

/**
 * Subscribe to the session.
 *
 * The `loading` state exists to prevent a flash of the login screen on every
 * reload: reading the persisted session from localStorage is async, so rendering
 * "signed out" before it resolves would blink the sign-in form at an
 * already-authenticated user once per refresh.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" })

  useEffect(() => {
    /*
     * Guards against a resolved `getSession()` landing after unmount, and — more
     * importantly under StrictMode's double-mount in development — against the
     * first effect's stale result overwriting the second's.
     */
    let active = true

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setState(toState(data.session))
      })
      .catch(() => {
        // A failure to *read* a session is not a session. Treat it as signed out
        // rather than hanging on "loading" forever with a blank screen.
        if (active) setState({ status: "signed-out" })
      })

    /*
     * Fires on sign-in, sign-out, and every hourly token refresh — which is what
     * keeps `session.access_token` in this state fresh rather than frozen at the
     * value it had when the tab was opened.
     */
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (active) setState(toState(session))
      }
    )

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  return state
}

function toState(session: Session | null): AuthState {
  return session
    ? { status: "signed-in", session, profile: profileFrom(session) }
    : { status: "signed-out" }
}

/**
 * Sign in, returning an error message rather than throwing.
 *
 * The message is deliberately whatever Supabase said, with one exception below:
 * a form needs something to render inline, and a thrown error in a submit
 * handler is an unhandled rejection.
 */
export async function signIn(
  email: string,
  password: string
): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (!error) return null

  /*
   * Supabase returns the same "Invalid login credentials" for a wrong password,
   * an unknown address, and an unconfirmed account. That's correct for a public
   * app — it refuses to confirm whether an address is registered — but for a
   * single-user internal tool it hides the most likely cause: the dashboard user
   * was created without "Auto Confirm User" ticked.
   */
  if (error.message.toLowerCase().includes("invalid login credentials")) {
    return "Wrong email or password — or the account was never confirmed. Check Authentication → Users in Supabase."
  }

  return error.message
}

export async function signOut(): Promise<string | null> {
  const { error } = await supabase.auth.signOut()
  return error ? error.message : null
}
