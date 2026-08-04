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
import type { Lead } from "@/lib/types"

interface DeleteLeadDialogProps {
  /** The recipient being removed; null closes the dialog. */
  lead: Lead | null
  onOpenChange: (open: boolean) => void
  onConfirm: (lead: Lead) => void
}

/**
 * Confirms removing a recipient from the Database.
 *
 * The delete button is an icon sitting immediately beside Edit on every row, so
 * it is easy to hit while reaching for the pencil — and unlike "Cancel schedule",
 * which this mirrors, there is nothing to undo afterwards.
 *
 * Deliberately one line, unlike `CancelScheduleDialog`. The consequences here are
 * the ones anybody deleting a row already assumes (it's gone, and it doesn't
 * unsend anything), so spelling them out just buries the address the reader is
 * actually checking. Cancel-schedule earns its paragraph because *its* outcome is
 * genuinely surprising — relaunching recomputes the send time rather than
 * resuming it.
 */
export function DeleteLeadDialog({
  lead,
  onOpenChange,
  onConfirm,
}: DeleteLeadDialogProps) {
  /*
   * The last recipient shown, kept so the sentence survives the close animation.
   * `lead` goes null the moment either button is pressed, but Radix keeps the
   * content mounted for the ~100ms fade — long enough to render "Do you really
   * want to remove from the Database?" with the address missing. That was
   * invisible in `CancelScheduleDialog`, which has a paragraph of other text to
   * hide it; here the address *is* the message.
   *
   * Adjusted during render rather than in an effect. That's React's documented
   * way to derive state from a changing prop, and unlike an effect it produces no
   * intermediate paint with the wrong value.
   */
  const [shown, setShown] = useState(lead)
  if (lead && lead.id !== shown?.id) setShown(lead)

  return (
    <Dialog open={!!lead} onOpenChange={onOpenChange}>
      {/* gap-0 because the three bands are separated by rules rather than by
          space, and each supplies its own padding. */}
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        {/* Negative margins would be the alternative, but this dialog sets no
            padding of its own, so each band can just pad itself. */}
        <DialogHeader className="border-b p-4">
          <DialogTitle>Confirm action</DialogTitle>
        </DialogHeader>

        {/* The address, not the name: it is what identifies a recipient here, and
            a lead imported from a CSV may have no name at all. */}
        <DialogDescription className="p-4 text-foreground">
          Do you really want to remove {shown?.email} from the Database?
        </DialogDescription>

        <DialogFooter className="m-0 rounded-b-xl border-t p-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/*
           * `default`, not `destructive`: this theme's destructive variant is a
           * tint (`bg-destructive/10`) meant for the small icon buttons in the
           * table, and at dialog-button size it reads as disabled rather than
           * dangerous. The dialog itself is what marks the action as weighty.
           */}
          <Button
            onClick={() => {
              if (!lead) return
              onConfirm(lead)
              onOpenChange(false)
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
