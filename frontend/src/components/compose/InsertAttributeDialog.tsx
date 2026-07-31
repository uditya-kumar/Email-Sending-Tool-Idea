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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MERGE_ATTRIBUTES, buildTag } from "@/lib/merge-tags"
import type { MergeAttributeKey } from "@/lib/types"

interface InsertAttributeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInsert: (tag: string) => void
}

/** "Add an attribute" modal — pick attribute + optional fallback value. */
export function InsertAttributeDialog({
  open,
  onOpenChange,
  onInsert,
}: InsertAttributeDialogProps) {
  const [attribute, setAttribute] = useState<MergeAttributeKey>("first_name")
  const [fallback, setFallback] = useState("")

  function handleInsert() {
    onInsert(buildTag(attribute, fallback.trim()))
    onOpenChange(false)
    setFallback("")
    setAttribute("first_name")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add an attribute</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Attribute</Label>
            <Select
              value={attribute}
              onValueChange={(v) => setAttribute(v as MergeAttributeKey)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MERGE_ATTRIBUTES.map((a) => (
                  <SelectItem key={a.key} value={a.key}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Fallback</Label>
            <Input
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
              placeholder=""
            />
            <p className="text-xs text-muted-foreground">
              Value if the attribute is empty
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleInsert}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
