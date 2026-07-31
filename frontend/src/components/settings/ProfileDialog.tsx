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
import type { SenderAccount, UserProfile } from "@/lib/types"

interface ProfileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The logged-in owner. Always present — this is who you are, not what sends. */
  profile: UserProfile
  /**
   * The Gmail connected for sending, or null when none is. Shown read-only so
   * it's clear the two are separate: disconnecting it doesn't touch the profile.
   */
  sender: SenderAccount | null
  /** Saves the edited display name (the only writable field here). */
  onSave: (name: string) => void
}

/**
 * The profile menu's "Profile" entry. Single-user tool, so this is just the
 * owner's identity: an editable display name plus their address. The sending
 * account is a separate thing entirely and is only reported here.
 */
export function ProfileDialog({
  open,
  onOpenChange,
  profile,
  sender,
  onSave,
}: ProfileDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Roomier than the default p-4: this dialog is a read-through of your
          identity, so the rows need air to stay scannable. */}
      <DialogContent className="gap-5 p-6 sm:max-w-sm">
        {/* Keyed so the name field re-initialises from the saved profile each
            time it opens — no effect needed to keep the draft in sync. */}
        <ProfileForm
          key={open ? profile.email : "closed"}
          profile={profile}
          sender={sender}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  )
}

function ProfileForm({
  profile,
  sender,
  onOpenChange,
  onSave,
}: Omit<ProfileDialogProps, "open">) {
  const [name, setName] = useState(profile.name)

  const trimmed = name.trim()
  const valid = trimmed.length > 0
  const dirty = trimmed !== profile.name

  function handleSave() {
    if (!valid || !dirty) return
    onSave(trimmed)
    onOpenChange(false)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Profile</DialogTitle>
        <DialogDescription>Your account for this tool.</DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        <div className="space-y-2">
          <Label htmlFor="profile-name">Display name</Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="Your name"
          />
        </div>

        <div className="space-y-2">
          <Label>Email address</Label>
          <p className="text-sm text-foreground">{profile.email}</p>
        </div>

        <div className="space-y-2">
          <Label>Sending account</Label>
          {/* Read-only: connected and capped in Settings, not here. */}
          {sender ? (
            <p className="text-sm text-foreground">
              {sender.email}
              <span className="text-muted-foreground">
                {" "}
                · {sender.dailyLimit}/day
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              None connected — add one in Settings to send email.
            </p>
          )}
        </div>
      </div>

      {/* Bleeds to the edge; the offsets have to track DialogContent's padding. */}
      <DialogFooter className="-mx-6 -mb-6">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!valid || !dirty}>
          Save
        </Button>
      </DialogFooter>
    </>
  )
}
