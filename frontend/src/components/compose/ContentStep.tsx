import { Clock, Mail } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SendTimePicker } from "@/components/common/SendTimePicker"
import { fullName } from "@/lib/leads"
import { SequenceSidebar } from "./SequenceSidebar"
import { EmailEditor } from "./EmailEditor"
import { useSubjectInsert } from "./use-subject-insert"
import { SendTestPopover } from "./SendTestPopover"
import { ApplyTemplateMenu } from "./ApplyTemplateMenu"
import { AttachmentBar } from "./AttachmentBar"
import { formatIST } from "@/lib/time"
import type {
  EmailTemplate,
  Lead,
  SequenceStep,
  StepAttachment,
  StepTiming,
} from "@/lib/types"

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
  /** When each email is due, keyed by step id — rendered in the sequence rail. */
  timings?: Map<string, StepTiming> | undefined
  /** The step after which the recipient replied — the rail marks the break there. */
  replyAfterStepId?: string | null | undefined
  /** Upload a file and attach it to the step being edited. */
  onAttach: (stepId: string, file: File) => Promise<void>
  onDetach: (stepId: string, attachment: StepAttachment) => Promise<void>
  /**
   * Flush pending content edits. Awaited before a test send, because the server
   * renders the stored row and ignores the request body.
   */
  onFlush: () => Promise<void>
  /** Whose merge data the test send renders against. */
  leadId: string
  /** True while a structural save is in flight — the sequence rail is read-only then. */
  busy?: boolean | undefined
  /** Connected Gmail address — the test send needs one to send from. */
  senderEmail?: string | undefined
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
  timings,
  replyAfterStepId,
  onAttach,
  onDetach,
  onFlush,
  leadId,
  busy,
  senderEmail,
}: ContentStepProps) {
  const active = steps.find((s) => s.id === activeStepId && s.kind === "email")
  const isFollowUp = active ? active.name.toLowerCase().includes("follow") : false

  /*
   * Routes an inserted merge tag to the subject when the caret was there. The button
   * that inserts it lives in the editor's toolbar, so this component — which owns
   * both fields — is the only place that can tell the two apart.
   */
  const subjectInsert = useSubjectInsert({
    subject: active?.subject ?? "",
    onChange: (subject) => active && onUpdateStep(active.id, { subject }),
    resetKey: activeStepId,
  })

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
        timings={timings}
        replyAfterStepId={replyAfterStepId}
        busy={busy}
      />

      {/* Dotted canvas */}
      <div className="canvas-dots flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {/* Per-recipient send time — the whole point of the per-lead flow. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 shadow-sm">
            <div className="text-sm">
              <p className="font-medium text-foreground">
                Writing to {fullName(lead) || lead.email}
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
              {/* Writes straight back to the lead, so the Database row updates too. */}
              <SendTimePicker
                id="send-time"
                value={lead.sendTimeIST}
                onChange={onChangeSendTime}
              />
              <ApplyTemplateMenu
                templates={templates}
                onApply={onApplyTemplate}
                busy={busy}
              />
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
                    {...subjectInsert.subjectProps}
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
                  {/*
                    `stepId` is this step's real `sequence_steps` UUID, and
                    `onBeforeSend` flushes the debounced saves — the server renders
                    the stored row rather than anything in the request, so without
                    the flush a test would email the last save instead of what's on
                    screen. `leadId` is what makes the tags resolve to this
                    recipient rather than to their fallbacks.
                  */}
                  <SendTestPopover
                    senderEmail={senderEmail}
                    stepId={active.id}
                    leadId={leadId}
                    onBeforeSend={onFlush}
                  />
                </div>

                <EmailEditor
                  key={active.id}
                  bodyHtml={active.bodyHtml ?? ""}
                  onChange={(html) => onUpdateStep(active.id, { bodyHtml: html })}
                  insertTarget={subjectInsert.insertTarget}
                  onInsertOutside={subjectInsert.insertIntoSubject}
                  onBodyFocus={subjectInsert.onBodyFocus}
                />

                {/*
                  Below the body, where an attachment sits in a real email client.
                  `busy` disables adding: a structural save can replace this step's
                  id, and `step_attachments` would then point at the old row.
                */}
                <AttachmentBar
                  attachments={active.attachments}
                  onAttach={(file) => onAttach(active.id, file)}
                  onDetach={(attachment) => onDetach(active.id, attachment)}
                  disabled={busy}
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
