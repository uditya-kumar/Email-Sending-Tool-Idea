import { useEffect, useState } from "react"
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
import { isValidIST } from "@/lib/time"
import type { Lead } from "@/lib/types"

interface LeadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When provided, the dialog edits this lead; otherwise it adds a new one. */
  lead?: Lead | null
  onSave: (lead: Lead) => void
}

type FormState = {
  companyName: string
  contactFullName: string
  email: string
  personalizationLine: string
  sendTimeIST: string
  jobTitle: string
  website: string
}

const EMPTY: FormState = {
  companyName: "",
  contactFullName: "",
  email: "",
  personalizationLine: "",
  sendTimeIST: "10:00",
  jobTitle: "",
  website: "",
}

function fromLead(lead: Lead): FormState {
  return {
    companyName: lead.companyName,
    contactFullName: lead.contactFullName,
    email: lead.email,
    personalizationLine: lead.personalizationLine,
    sendTimeIST: lead.sendTimeIST,
    jobTitle: lead.jobTitle ?? "",
    website: lead.website ?? "",
  }
}

/** Add or edit a lead with all column details. */
export function LeadDialog({ open, onOpenChange, lead, onSave }: LeadDialogProps) {
  const isEdit = Boolean(lead)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)

  // Reset the form whenever the dialog opens (with or without a lead to edit).
  useEffect(() => {
    if (open) {
      setForm(lead ? fromLead(lead) : EMPTY)
      setError(null)
    }
  }, [open, lead])

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleSave() {
    if (!form.email.trim() || !/^\S+@\S+\.\S+$/.test(form.email)) {
      setError("Please enter a valid email address.")
      return
    }
    if (!isValidIST(form.sendTimeIST)) {
      setError("Send time must be a valid time (HH:mm).")
      return
    }
    onSave({
      id: lead?.id ?? `manual-${form.email}-${form.sendTimeIST}`,
      companyName: form.companyName.trim(),
      contactFullName: form.contactFullName.trim(),
      email: form.email.trim(),
      personalizationLine: form.personalizationLine.trim(),
      sendTimeIST: form.sendTimeIST,
      jobTitle: form.jobTitle.trim() || undefined,
      website: form.website.trim() || undefined,
      verification: lead?.verification ?? "not_verified",
      status: lead?.status ?? "draft",
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit lead" : "Add a lead"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Company name">
              <Input
                value={form.companyName}
                onChange={(e) => set("companyName", e.target.value)}
                placeholder="Acme Inc."
              />
            </Field>
            <Field label="Contact person full name">
              <Input
                value={form.contactFullName}
                onChange={(e) => set("contactFullName", e.target.value)}
                placeholder="Jane Doe"
              />
            </Field>
          </div>

          <Field label="Email address" required>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="jane@acme.com"
            />
          </Field>

          <Field label="Personalization line">
            <Input
              value={form.personalizationLine}
              onChange={(e) => set("personalizationLine", e.target.value)}
              placeholder="your recent work on…"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Job title">
              <Input
                value={form.jobTitle}
                onChange={(e) => set("jobTitle", e.target.value)}
                placeholder="CEO"
              />
            </Field>
            <Field label="Send time (IST)" required>
              <Input
                type="time"
                value={form.sendTimeIST}
                onChange={(e) => set("sendTimeIST", e.target.value)}
              />
            </Field>
          </div>

          <Field label="Website">
            <Input
              value={form.website}
              onChange={(e) => set("website", e.target.value)}
              placeholder="https://acme.com"
            />
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>{isEdit ? "Save changes" : "Add lead"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
    </div>
  )
}
