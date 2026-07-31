import { Clock, Mail, Send } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SequenceSidebar } from "./SequenceSidebar"
import { EmailEditor } from "./EmailEditor"
import { ApplyTemplateMenu } from "./ApplyTemplateMenu"
import { formatIST } from "@/lib/time"
import type { EmailTemplate, Lead, SequenceStep } from "@/lib/types"

interface ContentStepProps {
  /** The one recipient this sequence belongs to. */
  lead: Lead
  steps: SequenceStep[]
  /** Saved sequence templates available to fill this recipient's whole setup. */
  templates: EmailTemplate[]
  onApplyTemplate: (template: EmailTemplate) => void
  activeStepId: string
  onSelectStep: (id: string) => void
  onUpdateStep: (id: string, patch: Partial<SequenceStep>) => void
  onAddStep: () => void
  onDuplicateStep: (id: string) => void
  onDeleteStep: (id: string) => void
  onChangeDelay: (id: string, waitDays: number) => void
  onChangeSendTime: (hhmm: string) => void
}

/** Compose step 1 — sequence sidebar + email composition canvas for one recipient. */
export function ContentStep({
  lead,
  steps,
  templates,
  onApplyTemplate,
  activeStepId,
  onSelectStep,
  onUpdateStep,
  onAddStep,
  onDuplicateStep,
  onDeleteStep,
  onChangeDelay,
  onChangeSendTime,
}: ContentStepProps) {
  const active = steps.find((s) => s.id === activeStepId && s.kind === "email")
  const isFollowUp = active ? active.name.toLowerCase().includes("follow") : false

  return (
    <div className="flex min-h-0 flex-1">
      <SequenceSidebar
        steps={steps}
        activeStepId={activeStepId}
        onSelect={onSelectStep}
        onAddStep={onAddStep}
        onDuplicateStep={onDuplicateStep}
        onDeleteStep={onDeleteStep}
        onChangeDelay={onChangeDelay}
      />

      {/* Dotted canvas */}
      <div className="canvas-dots flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {/* Per-recipient send time — the whole point of the per-lead flow. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 shadow-sm">
            <div className="text-sm">
              <p className="font-medium text-foreground">
                Writing to {lead.contactFullName || lead.email}
              </p>
              <p className="text-muted-foreground">
                {lead.companyName || "—"} · sends at {formatIST(lead.sendTimeIST)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Label
                htmlFor="send-time"
                className="gap-1.5 text-sm font-normal text-muted-foreground"
              >
                <Clock className="size-4" /> Send time (IST)
              </Label>
              <Input
                id="send-time"
                type="time"
                value={lead.sendTimeIST}
                onChange={(e) => onChangeSendTime(e.target.value)}
                className="h-8 w-28"
              />
              <ApplyTemplateMenu templates={templates} onApply={onApplyTemplate} />
            </div>
          </div>

          {active ? (
            <>
              {/* Email header card */}
              <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 font-medium text-foreground shadow-sm">
                <Mail className="size-4 text-muted-foreground" />
                {active.name}
              </div>

              {/* Compose card */}
              <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  <span className="text-sm font-medium text-muted-foreground">
                    Subject:
                  </span>
                  <Input
                    value={active.subject ?? ""}
                    onChange={(e) =>
                      onUpdateStep(active.id, { subject: e.target.value })
                    }
                    placeholder={
                      isFollowUp
                        ? "Leave it blank to send as a reply to your previous email"
                        : "Write a subject line…"
                    }
                    className="h-8 flex-1 border-0 px-0 text-foreground shadow-none focus-visible:ring-0"
                  />
                  <Send className="size-4 text-muted-foreground" />
                </div>

                <EmailEditor
                  key={active.id}
                  bodyHtml={active.bodyHtml ?? ""}
                  onChange={(html) => onUpdateStep(active.id, { bodyHtml: html })}
                />
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-dashed bg-card/50 px-4 py-10 text-center text-muted-foreground">
              Select an email step to edit its content, or apply a template above.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
