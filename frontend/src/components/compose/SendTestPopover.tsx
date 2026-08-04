import { useState } from "react"
import { Loader2, Send } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ApiError, sendTest } from "@/lib/api"
import { isPersistedStepId } from "@/lib/sequences"

interface SendTestPopoverProps {
  /**
   * The Gmail account connected in Settings — undefined when none is, which is
   * also what blocks the send. Doubles as the prefilled recipient, since a test
   * almost always goes to yourself.
   */
  senderEmail?: string | undefined
  /**
   * The `template_steps` / `sequence_steps` row to send — a real database UUID,
   * not a client-side id. Undefined while the step has never been saved, which
   * blocks the send: the server renders the row it reads by this id, so there is
   * nothing to send yet.
   */
  stepId?: string | undefined
  /**
   * Whose data to merge into the tags. Omitted on the Templates page, where there
   * is no recipient — every tag then falls back to its own default, which is
   * exactly what the Preview shows.
   */
  leadId?: string | undefined
  /**
   * Flush pending editor edits before sending. The server re-reads the step from
   * the database and ignores anything in the request body, so without this a test
   * would show the last *saved* text rather than what's on screen.
   */
  onBeforeSend?: (() => Promise<void>) | undefined
}

/** Loose sanity check; Gmail is the real validator. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/**
 * The send arrow at the end of the subject bar: sends the email being edited to
 * one address so you can see how it lands in a real inbox.
 *
 * Needs a connected account to send from, so with none it says so and points at
 * Settings rather than offering a button that can't work.
 */
export function SendTestPopover({
  senderEmail,
  stepId,
  leadId,
  onBeforeSend,
}: SendTestPopoverProps) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState(senderEmail ?? "")
  const [busy, setBusy] = useState(false)

  const connected = !!senderEmail
  const valid = looksLikeEmail(email)

  async function handleSend() {
    if (!connected || !valid || busy) return

    /*
     * A missing id and a placeholder id are the same problem: the server resolves
     * the step by id, so neither can be sent. Checked rather than trusted because a
     * placeholder is *present*, and would otherwise reach the server as a 400 on a
     * uuid parse — a worse message for the same cause.
     */
    if (!stepId || !isPersistedStepId(stepId)) {
      toast.error("Nothing to send yet", {
        description: "This email hasn't saved yet. Give it a moment and try again.",
      })
      return
    }

    setBusy(true)

    try {
      // Save first — the test email is rendered from the stored row, not from
      // what's in the editor.
      await onBeforeSend?.()

      const result = await sendTest({
        stepId,
        to: email.trim(),
        ...(leadId ? { leadId } : {}),
      })

      setOpen(false)
      toast.success(`Test email sent to ${result.to}`, {
        // The server prefixes the real subject with "[TEST] " — say so, so the
        // subject in the inbox doesn't look like a bug. The attachment list comes
        // from the files the server actually downloaded and attached, so it is the
        // only confirmation that a file made it into the message rather than just
        // into the bucket.
        description: `Sent from ${result.from} as “[TEST] ${result.subject}”${
          result.attachments.length > 0
            ? ` with ${result.attachments.join(", ")}`
            : ""
        }.`,
      })
    } catch (error) {
      toast.error("Couldn't send the test", { description: describe(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      {/*
       * Tooltip inside the popover trigger, wrapping the button: an unlabelled
       * icon gives no clue what the arrow does until it's clicked. Nesting this
       * way — `PopoverTrigger asChild` → `TooltipTrigger asChild` → `Button` —
       * collapses all three onto the one element, so the button keeps both the
       * popover's and the tooltip's handlers instead of one shadowing the other.
       *
       * Hidden once the popover is open (`open ? "" : undefined`). Otherwise the
       * tooltip sits over the panel it just opened, describing an action the panel
       * now states outright on its own button.
       */}
      <TooltipProvider>
        <Tooltip {...(open ? { open: false } : {})}>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Send a test email"
              >
                <Send />
              </Button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent>Send test email</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-80 space-y-3">
        {connected ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="test-email">Send test to</Label>
              <Input
                id="test-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSend()}
                disabled={busy}
              />
            </div>
            <Button
              className="w-full"
              onClick={() => void handleSend()}
              disabled={!valid || busy}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Sending…" : "Send test email"}
            </Button>
          </>
        ) : (
          <div className="space-y-1.5">
            <p className="font-medium text-foreground">No account connected</p>
            <p className="text-xs text-muted-foreground">
              Connect a Gmail account in Settings before sending a test.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The server's message, verbatim where there is one.
 *
 * Every 409 from the send path is written to be shown to the user as-is ("This
 * email has no subject.", "Connect a Gmail account in Settings before sending.")
 * — rewording them here would only make them vaguer.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}
