import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SenderAccount } from "@/lib/types"

interface SenderLimitDialogProps {
  /** The account being edited; null closes the dialog. */
  sender: SenderAccount | null
  onOpenChange: (open: boolean) => void
  onSave: (dailyLimit: number) => void
}

/**
 * Edits a connected account's daily send limit — the only sender setting this
 * tool has. Replaced a full slide-over panel: with one Gmail account and one
 * editable field, a panel with tabs and usage charts was more chrome than data.
 */
export function SenderLimitDialog({
  sender,
  onOpenChange,
  onSave,
}: SenderLimitDialogProps) {
  return (
    // Keyed on the account so the field re-initialises from its current limit
    // each time the dialog opens — no effect needed to sync the two.
    <LimitForm
      key={sender?.id ?? "none"}
      sender={sender}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

function LimitForm({ sender, onOpenChange, onSave }: SenderLimitDialogProps) {
  // Held as a string so a half-typed number can't be committed as the live cap.
  const [limit, setLimit] = useState(() => String(sender?.dailyLimit ?? ""))

  const parsed = Number(limit)
  const valid = Number.isInteger(parsed) && parsed >= 1

  function handleSave() {
    if (!valid) return
    onSave(parsed)
    onOpenChange(false)
  }

  return (
    <Dialog open={!!sender} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Daily send limit</DialogTitle>
          <DialogDescription>{sender?.email}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 py-1">
          <Label htmlFor="daily-limit">Emails per day</Label>
          <Input
            id="daily-limit"
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            className="w-32"
          />
          <p className="text-xs text-muted-foreground">
            Keep it at 15–50 for cold outreach — deliverability degrades long
            before Gmail's hard cap.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
