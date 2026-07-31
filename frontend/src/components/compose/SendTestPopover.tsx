import { useState } from "react"
import { Send } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface SendTestPopoverProps {
  /**
   * The Gmail account connected in Settings — undefined when none is, which is
   * also what blocks the send. Doubles as the prefilled recipient, since a test
   * almost always goes to yourself.
   */
  senderEmail?: string
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
export function SendTestPopover({ senderEmail }: SendTestPopoverProps) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState(senderEmail ?? "")

  const connected = !!senderEmail
  const valid = looksLikeEmail(email)

  function handleSend() {
    if (!connected || !valid) return
    setOpen(false)
    toast.success(`Test email sent to ${email.trim()}`, {
      description: `Sent from ${senderEmail}.`,
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Send a test email"
        >
          <Send />
        </Button>
      </PopoverTrigger>

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
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
              />
            </div>
            <Button className="w-full" onClick={handleSend} disabled={!valid}>
              Send test email
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
