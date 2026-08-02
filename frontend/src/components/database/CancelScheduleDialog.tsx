import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { fullName } from "@/lib/leads"
import { formatIST } from "@/lib/time"
import type { Lead } from "@/lib/types"

interface CancelScheduleDialogProps {
  /** The recipient being un-scheduled; null closes the dialog. */
  lead: Lead | null
  onOpenChange: (open: boolean) => void
  onConfirm: (lead: Lead) => void
}

/**
 * Confirms un-scheduling a launched recipient.
 *
 * "Cancel schedule" is the *only* action shown on a scheduled row, sitting where
 * Send, Edit and Delete are on every other row — so it is easy to hit while
 * reaching for one of those, and it fires against an email that may be minutes
 * from going out.
 *
 * Worth a dialog even though the work is undoable by relaunching, because the
 * queued row is discarded rather than paused: relaunching computes a fresh send
 * time from the recipient's IST time and the outreach days, which for a cancel at
 * 11:55 PM means the next send lands a day later, not five minutes later.
 */
export function CancelScheduleDialog({
  lead,
  onOpenChange,
  onConfirm,
}: CancelScheduleDialogProps) {
  const who = lead ? fullName(lead) || lead.email : ""

  return (
    <Dialog open={!!lead} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel this schedule?</DialogTitle>
          {/* `formatIST` rather than the raw "HH:mm" — every other mention of a
              send time in the app is 12-hour and already carries the "IST", and
              a bare "12:35" here is genuinely ambiguous about noon vs midnight. */}
          <DialogDescription>
            {lead ? `${who} is queued to send at ${formatIST(lead.sendTimeIST)}.` : ""}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          The queued email won't go out and {who} returns to draft. You can edit
          the message and launch again — the new send time is worked out from
          scratch, so it won't necessarily be today. Emails already delivered
          can't be recalled.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it scheduled
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (!lead) return
              onConfirm(lead)
              onOpenChange(false)
            }}
          >
            Cancel schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
