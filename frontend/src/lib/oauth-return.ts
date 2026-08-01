/**
 * Reading the result of the Google OAuth round trip out of the URL.
 *
 * The Express callback finishes by redirecting the browser to
 * `${FRONTEND_URL}/settings?connected=1&email=…` or `…/settings?error=…`. This app
 * has no router — the current page is a `useState<AppView>` — so `/settings` is
 * not a route that resolves to anything. Vite's dev server serves index.html for
 * it, the app boots at its default view, and the query string is the only trace
 * left of what happened.
 *
 * So the query string is what we read, once, on mount.
 */

export type OAuthReturn =
  | { kind: "connected"; email: string | null }
  | { kind: "error"; message: string }

/**
 * Parse and then **erase** the OAuth result from the address bar.
 *
 * Consuming is deliberately part of reading: `?connected=1` left in place would
 * re-toast "Connected" on every reload, and an `?error=` would make a transient
 * failure look permanent. `replaceState` rather than `pushState` so the Back
 * button doesn't walk back into the consumed URL.
 */
export function consumeOAuthReturn(): OAuthReturn | null {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get("connected")
  const error = params.get("error")

  if (!connected && !error) return null

  const email = params.get("email")

  params.delete("connected")
  params.delete("email")
  params.delete("error")

  const query = params.toString()
  /*
   * Back to "/" rather than keeping the "/settings" path. The path is a fiction
   * invented by the redirect — nothing in this app routes on it — and leaving it
   * would make a later reload request a URL the dev server only serves by
   * SPA-fallback.
   */
  window.history.replaceState(null, "", query ? `/?${query}` : "/")

  if (error) return { kind: "error", message: error }

  return { kind: "connected", email }
}
