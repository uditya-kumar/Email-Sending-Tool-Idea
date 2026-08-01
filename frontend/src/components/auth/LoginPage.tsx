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

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy

  async function handleSubmit(event: React.FormEvent) {
    // A real <form> so Enter submits and password managers recognise it; that
    // means suppressing the navigation the browser would otherwise do.
    event.preventDefault()
    if (!canSubmit) return

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
              type="email"
              // Not `autoFocus` on the password field: the browser fills both
              // from a saved credential, and focusing email first matches the
              // reading order when it doesn't.
              autoFocus
              autoComplete="username"
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
              type="password"
              autoComplete="current-password"
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

          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  )
}
