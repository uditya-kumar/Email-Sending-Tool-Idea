import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { EmailTemplate } from "@/lib/types"

interface RenameTemplateDialogProps {
  /** The template being renamed; null closes the dialog. */
  template: EmailTemplate | null
  onOpenChange: (open: boolean) => void
  onSave: (name: string) => void
}

/**
 * Renames a template from its row menu. The header field only edits whichever
 * template is open, so this is how any other one in the rail gets renamed.
 */
export function RenameTemplateDialog({
  template,
  onOpenChange,
  onSave,
}: RenameTemplateDialogProps) {
  return (
    <Dialog open={!!template} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 p-6 sm:max-w-sm">
        {/* Keyed on the template so the field re-seeds from its current name
            each time the dialog opens — no effect needed to sync the two. */}
        <RenameForm
          key={template?.id ?? "none"}
          template={template}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({
  template,
  onOpenChange,
  onSave,
}: RenameTemplateDialogProps) {
  const [name, setName] = useState(template?.name ?? "")

  const trimmed = name.trim()
  const valid = trimmed.length > 0

  function handleSave() {
    if (!valid) return
    onSave(trimmed)
    onOpenChange(false)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename template</DialogTitle>
      </DialogHeader>

      <div className="space-y-2 py-1">
        <Label htmlFor="template-name">Template name</Label>
        <Input
          id="template-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          placeholder="e.g. AI engineering outreach"
          autoFocus
        />
      </div>

      {/* Bleeds to the edge; the offsets have to track DialogContent's padding. */}
      <DialogFooter className="-mx-6 -mb-6">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!valid}>
          Save
        </Button>
      </DialogFooter>
    </>
  )
}
