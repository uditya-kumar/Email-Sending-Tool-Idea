import { Loader2, Mail } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { signIn } from "@/lib/auth"

/**
 * The sign-in screen. Nothing else in the app renders until this succeeds.
 *
 * There is no "sign up" and no "forgot password" — signups are disabled in the
 * Supabase dashboard and this tool has exactly one account, created by hand. A
 * password reset would need a working outbound mailer, which is the thing the
 * built-in one isn't; if the password is lost, it gets changed in the dashboard.
 */
export function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const filled = email.trim().length > 0 && password.length > 0

  async function handleSubmit(event: React.FormEvent) {
    // A real <form> so Enter submits and password managers recognise it; that
    // means suppressing the navigation the browser would otherwise do.
    event.preventDefault()
    if (!filled || busy) return

    setBusy(true)
    setError(null)

    const message = await signIn(email.trim(), password)

    /*
     * On success this component is about to be unmounted by the auth state
     * change, so `busy` is deliberately left true — clearing it would re-enable
     * the button for the frame before the swap and allow a double submit.
     */
    if (message) {
      setError(message)
      setBusy(false)
    }
  }

  return (
    <div className="flex h-svh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card">
            <Mail className="size-5 text-accent" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-foreground">Sign in</h1>
            <p className="text-sm text-muted-foreground">
              Your outreach workspace.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-email">Email address</Label>
            <Input
              id="login-email"
              // `name` as well as `id`: without it Chrome won't offer to save the
              // credential, and it reports the field as unnamed in the issues panel.
              name="email"
              type="email"
              /*
               * Deliberately not `autoFocus`. The focus ring here is the theme's
               * orange, which on an empty required-looking field reads as a
               * validation error the moment the page loads — nothing has gone
               * wrong yet. The user's first action on a sign-in screen is to
               * click or Tab into this field anyway.
               */
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={busy}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={busy}
            />
          </div>

          {/* aria-live so a screen reader announces a failed attempt, which is
              otherwise a silent visual-only change. */}
          {error && (
            <p
              role="alert"
              aria-live="polite"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          {/*
            Disabled only while a request is in flight, not while the fields are
            empty. A `disabled` primary button is `bg-primary` at 50% opacity,
            which on an otherwise blank page reads as a broken control rather
            than as "fill this in first" — and it's the only thing on screen to
            compare against. An empty submit is cheap to ignore in
            `handleSubmit`; browser `required` validation catches it too.
          */}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  )
}
