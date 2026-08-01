import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { SendTimePicker } from "@/components/common/SendTimePicker"
import { isValidLeadEmail, type NewLead } from "@/lib/leads"
import { isValidIST } from "@/lib/time"
import type { Lead } from "@/lib/types"

interface LeadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When provided, the dialog edits this lead; otherwise it adds a new one. */
  lead?: Lead | null
  /**
   * Persist. Resolves `true` once the row is written, `false` if the write failed
   * — the dialog stays open on `false` so the typed values aren't lost, and the
   * reason has already been reported by the caller.
   *
   * A `NewLead` rather than a `Lead`: the id comes from Postgres, and `status` /
   * `repliedAt` are the scheduler's.
   */
  onSave: (lead: NewLead) => Promise<boolean>
}

type FormState = {
  companyName: string
  firstName: string
  lastName: string
  email: string
  personalizationLine: string
  sendTimeIST: string
  jobTitle: string
  website: string
}

const EMPTY: FormState = {
  companyName: "",
  firstName: "",
  lastName: "",
  email: "",
  personalizationLine: "",
  sendTimeIST: "10:00",
  jobTitle: "",
  website: "",
}

function fromLead(lead: Lead): FormState {
  return {
    companyName: lead.companyName,
    firstName: lead.firstName,
    lastName: lead.lastName,
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
  /** True from the Save click until the write resolves. */
  const [saving, setSaving] = useState(false)

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

  async function handleSave() {
    /*
     * Both checks are the database's own, via `shared/`: `isValidLeadEmail` is the
     * `leads_email_check` regex and `isValidIST` the `send_time_ist` one. Anything
     * that gets past here inserts; anything that doesn't would have come back as a
     * 23514 with the constraint's name in it.
     */
    if (!isValidLeadEmail(form.email)) {
      setError("Please enter a valid email address.")
      return
    }
    if (!isValidIST(form.sendTimeIST)) {
      setError("Send time must be a valid time (HH:mm).")
      return
    }

    setError(null)
    setSaving(true)

    const saved = await onSave({
      companyName: form.companyName.trim(),
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      // Lowercased to match the CSV importer: `(user_id, lower(email))` is unique,
      // so differing case would otherwise be a 23505 rather than an obvious clash.
      email: form.email.trim().toLowerCase(),
      personalizationLine: form.personalizationLine.trim(),
      sendTimeIST: form.sendTimeIST,
      jobTitle: form.jobTitle.trim() || undefined,
      website: form.website.trim() || undefined,
      verification: lead?.verification ?? "not_verified",
    })

    setSaving(false)

    // Held open on failure so the typed values survive a duplicate address or a
    // dropped connection. The caller has already said what went wrong.
    if (saved) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit lead" : "Add a lead"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* First and last are stored separately so a greeting can use the
              first name alone — see the {{first_name}} merge tag. */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="First name">
              <Input
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                placeholder="Jane"
              />
            </Field>
            <Field label="Last name">
              <Input
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                placeholder="Doe"
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

          <div className="grid grid-cols-2 gap-4">
            <Field label="Company name">
              <Input
                value={form.companyName}
                onChange={(e) => set("companyName", e.target.value)}
                placeholder="Acme Inc."
              />
            </Field>
            <Field label="Job title">
              <Input
                value={form.jobTitle}
                onChange={(e) => set("jobTitle", e.target.value)}
                placeholder="CEO"
              />
            </Field>
          </div>

          <Field label="Personalization line">
            <Textarea
              value={form.personalizationLine}
              onChange={(e) => set("personalizationLine", e.target.value)}
              placeholder="your recent work on…"
              rows={3}
              className="min-h-20 resize-y"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Send time (IST)" required>
              <SendTimePicker
                value={form.sendTimeIST}
                onChange={(hhmm) => set("sendTimeIST", hhmm)}
                className="w-full"
              />
            </Field>
            <Field label="Website">
              <Input
                value={form.website}
                onChange={(e) => set("website", e.target.value)}
                placeholder="https://acme.com"
              />
            </Field>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="gap-1.5" disabled={saving} onClick={() => void handleSave()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add lead"}
          </Button>
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
