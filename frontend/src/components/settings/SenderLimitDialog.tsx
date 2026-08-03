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
import { sharePctFor, splitBudget } from "@shared/send-budget.ts"
import type { SenderAccount } from "@/lib/types"

interface SenderLimitDialogProps {
  /** The account being edited; null closes the dialog. */
  sender: SenderAccount | null
  onOpenChange: (open: boolean) => void
  onSave: (dailyLimit: number, followUpSharePct: number) => void
}

/**
 * Edits a connected account's daily send budget: how many emails a day, and how
 * many of those are held for follow-ups. Replaced a full slide-over panel — with one
 * Gmail account, a panel with tabs and usage charts was more chrome than data.
 */
export function SenderLimitDialog({
  sender,
  onOpenChange,
  onSave,
}: SenderLimitDialogProps) {
  return (
    // Keyed on the account so the fields re-initialise from its current budget each
    // time the dialog opens — no effect needed to sync the two.
    <LimitForm
      key={sender?.id ?? "none"}
      sender={sender}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

function LimitForm({ sender, onOpenChange, onSave }: SenderLimitDialogProps) {
  /*
   * Both held as strings so a half-typed number can't be committed as the live cap,
   * and so clearing a field reads as empty rather than snapping to 0.
   *
   * Follow-ups are edited as a **count** even though a percentage is what's stored:
   * nobody reasons about outreach in percentages, and "6 of 15" is checkable against
   * the queue in a way "40%" isn't. `sharePctFor` converts on save.
   */
  const initialLimit = sender?.dailyLimit ?? 15
  const initialPct = sender?.followUpSharePct ?? 50

  const [limit, setLimit] = useState(() => String(sender?.dailyLimit ?? ""))
  const [followUps, setFollowUps] = useState(() =>
    String(splitBudget(initialLimit, initialPct).followUps)
  )

  /*
   * The ratio, kept alongside the two counts because it is what rescaling has to be
   * derived *from*. Re-deriving it from the displayed count on each keystroke loses
   * it: retyping the cap 10 → 15 passes through "1", where 60% floors to 0
   * follow-ups, and rescaling from 0 gives 15/0 instead of 9/6. Only an edit to the
   * follow-up field itself moves this.
   */
  const [sharePct, setSharePct] = useState(initialPct)

  const parsedLimit = Number(limit)
  const parsedFollowUps = Number(followUps)

  const limitValid = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 500
  const followUpsValid =
    Number.isInteger(parsedFollowUps) &&
    parsedFollowUps >= 0 &&
    (!limitValid || parsedFollowUps <= parsedLimit)

  const valid = limitValid && followUpsValid && limit.trim() !== "" && followUps.trim() !== ""

  /*
   * Raising the cap keeps the *ratio*, not the count: warming up from 10/day to
   * 15/day with 6 reserved gives 9, not 6, because otherwise every new slot would
   * quietly go to outreach and the balance the user chose would erode as they scale.
   */
  function handleLimitChange(next: string) {
    setLimit(next)

    const nextLimit = Number(next)
    if (!Number.isInteger(nextLimit) || nextLimit < 1 || nextLimit > 500) return

    setFollowUps(String(splitBudget(nextLimit, sharePct).followUps))
  }

  function handleFollowUpsChange(next: string) {
    setFollowUps(next)

    const nextFollowUps = Number(next)
    if (!Number.isInteger(nextFollowUps) || nextFollowUps < 0 || !limitValid) return
    if (nextFollowUps > parsedLimit) return

    setSharePct(sharePctFor(parsedLimit, nextFollowUps))
  }

  function handleSave() {
    if (!valid) return
    // sharePct is recomputed rather than trusted: it only tracks *valid* edits, so a
    // field left mid-edit could otherwise save a share that doesn't match the count
    // on screen.
    onSave(parsedLimit, sharePctFor(parsedLimit, parsedFollowUps))
    onOpenChange(false)
  }

  // Never negative even mid-typing: an invalid pair is reported by the hint below
  // rather than by rendering "-3 new outreach".
  const outreach = valid ? parsedLimit - parsedFollowUps : null

  return (
    <Dialog open={!!sender} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Daily send budget</DialogTitle>
          <DialogDescription>{sender?.email}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="daily-limit">Emails per day</Label>
            <Input
              id="daily-limit"
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => handleLimitChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">
              Keep it at 15–50 for cold outreach — deliverability degrades long
              before Gmail's hard cap.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="follow-up-quota">Reserved for follow-ups</Label>
            <Input
              id="follow-up-quota"
              type="number"
              min={0}
              max={limitValid ? parsedLimit : undefined}
              value={followUps}
              onChange={(e) => handleFollowUpsChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              className="w-32"
            />
            {/*
              The borrowing rule is stated here rather than left implicit: read as a
              hard quota, "6 follow-ups" looks like it would waste four slots on a day
              with no new leads, and the natural reaction is to keep re-editing it.
            */}
            {outreach === null ? (
              <p className="text-xs text-destructive">
                Enter a whole number from 0 to the daily limit.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Leaves {outreach} for new outreach. Either side can use the other's
                unused slots, so a day with only follow-ups still sends{" "}
                {parsedLimit}.
              </p>
            )}
          </div>
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
