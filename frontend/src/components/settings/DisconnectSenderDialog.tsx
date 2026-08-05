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
import type { SenderAccount } from "@/lib/types"

interface DisconnectSenderDialogProps {
  /** The account being disconnected; null closes the dialog. */
  sender: SenderAccount | null
  /**
   * How many *other* accounts would still be able to send afterwards. Zero means
   * this is the last one, which is a materially different outcome — see below.
   */
  remainingActive: number
  onOpenChange: (open: boolean) => void
  onConfirm: (sender: SenderAccount) => void
}

/**
 * Confirms disconnecting a sending account.
 *
 * Mirrors `DeleteLeadDialog` — same banded shell, same "Confirm action" title —
 * because the trigger is the same shape: a destructive icon button sitting
 * immediately beside Edit, easy to hit while reaching for the pencil.
 *
 * It carries one extra line that the lead dialog deliberately omits. Deleting a
 * lead has exactly the consequences anybody expects, but disconnecting a mailbox
 * has one that is genuinely surprising: recipients already mid-sequence on it
 * **stall**. A follow-up cannot be moved to another account, because Gmail's
 * `threadId` is scoped to the mailbox that issued it and sending from elsewhere
 * would put a second sender inside the recipient's thread. So those sequences wait
 * for a reconnect rather than being picked up by whatever else is connected — the
 * opposite of what "you have another account" suggests.
 */
export function DisconnectSenderDialog({
  sender,
  remainingActive,
  onOpenChange,
  onConfirm,
}: DisconnectSenderDialogProps) {
  /*
   * The last account shown, kept so the sentence survives the close animation.
   * `sender` goes null the moment either button is pressed, but Radix keeps the
   * content mounted for the ~100ms fade — long enough to render "disconnect from
   * sending?" with the address missing. Same reasoning as `DeleteLeadDialog`: the
   * address *is* the message here.
   *
   * Adjusted during render rather than in an effect, which is React's documented
   * way to derive state from a changing prop and produces no intermediate paint
   * with the wrong value.
   */
  const [shown, setShown] = useState(sender)
  if (sender && sender.id !== shown?.id) setShown(sender)

  return (
    <Dialog open={!!sender} onOpenChange={onOpenChange}>
      {/* gap-0 because the bands are separated by rules rather than by space, and
          each supplies its own padding. */}
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b p-4">
          <DialogTitle>Confirm action</DialogTitle>
        </DialogHeader>

        <DialogDescription className="p-4 text-foreground">
          Do you really want to disconnect {shown?.email} from sending?
        </DialogDescription>

        {/*
          Outside the description, in muted text, so the question above stays the
          thing being read first — the address is what the reader is checking.

          Both branches are worth stating because "disconnect" understates it in
          different directions: with accounts left it sounds like the work simply
          moves, and with none left it sounds reversible in a way that still
          leaves every launch blocked until a reconnect.
        */}
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {remainingActive > 0
            ? `Recipients already mid-sequence on it stop receiving follow-ups until it's reconnected — a follow-up can't move to another account without breaking the thread. ${remainingActive} other sending ${remainingActive === 1 ? "account" : "accounts"} stays connected.`
            : "This is your only sending account, so nothing will be able to send until you connect one again."}
        </p>

        <DialogFooter className="m-0 rounded-b-xl border-t p-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/*
           * `default`, not `destructive`: this theme's destructive variant is a
           * tint (`bg-destructive/10`) meant for the small icon buttons in the
           * table, and at dialog-button size it reads as disabled rather than
           * dangerous. Matches `DeleteLeadDialog`.
           */}
          <Button
            onClick={() => {
              if (!sender) return
              onConfirm(sender)
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
