import { useState } from "react"
import { toast } from "sonner"
import { ComposeHeader } from "./ComposeHeader"
import { ContentStep } from "./ContentStep"
import { PreviewStep } from "./PreviewStep"
import { fullName } from "@/lib/leads"
import {
  appendFollowUp,
  describeSequence,
  duplicateEmailStep,
  removeEmailStep,
  setDelayDays,
} from "@/lib/sequence"
import type {
  ComposeStep,
  EmailTemplate,
  Lead,
  SequenceStep,
  StepAttachment,
} from "@/lib/types"

interface ComposeFlowProps {
  lead: Lead
  steps: SequenceStep[]
  /**
   * Persist a whole new step list, resolving to the **saved** list.
   *
   * Structural edits go through here rather than through a local setter because
   * Postgres assigns the ids of new steps, and nothing can be test-sent or launched
   * from a step whose id is still a local placeholder. The resolved value is what
   * the selection is re-derived from.
   */
  onStepsChange: (steps: SequenceStep[]) => Promise<SequenceStep[]>
  /** Content-only edit of one step — debounced by the store, not written here. */
  onEditStep: (stepId: string, patch: Partial<SequenceStep>) => void
  /**
   * Drop a whole template onto this recipient, resolving to the saved list.
   *
   * Separate from `onStepsChange` because a template also carries its **attached
   * files**, and those can only be linked once the new step rows have ids. The store
   * owns that second write.
   */
  onApplyTemplate: (template: EmailTemplate) => Promise<SequenceStep[]>
  /** Saved sequence templates the user can drop onto this recipient. */
  templates: EmailTemplate[]
  /**
   * The one lead field this flow edits, written straight through to `leads`.
   *
   * Deliberately narrower than the `(patch: Partial<Lead>) => void` it replaced:
   * that shape suggested any field could be changed here, and now that the patch
   * has to reach the database, a caller passing `{ status }` or `{ email }` would
   * have been quietly dropped.
   */
  onChangeSendTime: (hhmm: string) => void
  /**
   * Attach / detach a file on one step. Rejects with a message meant to be shown —
   * `AttachmentBar` reports it against the file it belongs to, which is why these
   * throw rather than route through the store's `onError`.
   */
  onAttach: (stepId: string, file: File) => Promise<void>
  onDetach: (stepId: string, attachment: StepAttachment) => Promise<void>
  /** Queue the opening email. Resolves when the server has answered. */
  onLaunch: () => Promise<void>
  onBack: () => void
  /** Flush pending content edits — awaited before a test send. */
  onFlush: () => Promise<void>
  /** Connected Gmail address — the test send needs one to send from. */
  senderEmail?: string | undefined
}

/**
 * The per-recipient send flow opened from a Database row:
 * Content → Preview, with Launch available on Preview only.
 */
export function ComposeFlow({
  lead,
  steps,
  onStepsChange,
  onEditStep,
  onApplyTemplate,
  templates,
  onChangeSendTime,
  onAttach,
  onDetach,
  onLaunch,
  onBack,
  onFlush,
  senderEmail,
}: ComposeFlowProps) {
  const [step, setStep] = useState<ComposeStep>("content")
  /**
   * What the user has *chosen*, which is not the same as what's shown.
   *
   * Resolved against the current list below rather than kept in sync with it by an
   * effect: steps arrive asynchronously and every structural save can replace a
   * placeholder id with a real one, so a stored selection routinely stops existing.
   * Deriving it means both cases fall out for free instead of each needing a
   * corrective effect that renders one wrong frame first.
   */
  const [chosenStepId, setChosenStepId] = useState("")
  /** True while a structural save or the launch request is in flight. */
  const [busy, setBusy] = useState(false)

  const active =
    steps.find((s) => s.id === chosenStepId && s.kind === "email") ??
    steps.find((s) => s.kind === "email")

  const activeStepId = active?.id ?? ""

  const contentReady = steps.some(
    (s) => s.kind === "email" && (s.subject || s.bodyHtml)
  )

  async function addStep() {
    const { steps: next } = appendFollowUp(steps, lead.id)
    setBusy(true)
    const saved = await onStepsChange(next)
    setBusy(false)
    // Select the new follow-up by position, not by the id `appendFollowUp`
    // invented — the persisted rows carry database-assigned ids instead.
    setChosenStepId(saved.filter((s) => s.kind === "email").at(-1)?.id ?? "")
  }

  async function deleteStep(id: string) {
    setBusy(true)
    await onStepsChange(removeEmailStep(steps, id))
    setBusy(false)
    // No replacement needed: an id that no longer exists resolves to the first
    // remaining email on the next render.
  }

  async function runStructural(next: SequenceStep[]) {
    setBusy(true)
    await onStepsChange(next)
    setBusy(false)
  }

  /**
   * Drop a saved template in wholesale: every email, follow-up, wait — and the files
   * attached to it.
   */
  async function applyTemplate(template: EmailTemplate) {
    setBusy(true)
    const saved = await onApplyTemplate(template)
    setBusy(false)
    setChosenStepId(saved.find((s) => s.kind === "email")?.id ?? "")

    /*
     * The files are worth naming in the toast: they arrive silently otherwise, and
     * "did my resume come along?" is exactly the question this feature exists to stop
     * the user asking.
     */
    const files = saved.reduce((sum, step) => sum + (step.attachments?.length ?? 0), 0)
    const withFiles =
      files > 0 ? ` · ${files} attachment${files === 1 ? "" : "s"}` : ""

    toast.success(`Applied "${template.name}"`, {
      description: `${describeSequence(saved)}${withFiles} — edit anything below for ${
        fullName(lead) || lead.email
      }.`,
    })
  }

  async function launch() {
    setBusy(true)
    await onLaunch()
    setBusy(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ComposeHeader
        lead={lead}
        step={step}
        onStepChange={setStep}
        onBack={onBack}
        contentReady={contentReady}
      />

      {step === "content" ? (
        <ContentStep
          lead={lead}
          steps={steps}
          templates={templates}
          onApplyTemplate={(template) => void applyTemplate(template)}
          activeStepId={activeStepId}
          onSelectStep={setChosenStepId}
          onUpdateStep={onEditStep}
          onAddStep={() => void addStep()}
          onDuplicateStep={(id) => void runStructural(duplicateEmailStep(steps, id))}
          onDeleteStep={(id) => void deleteStep(id)}
          onChangeDelay={(id, days) => void runStructural(setDelayDays(steps, id, days))}
          onChangeSendTime={onChangeSendTime}
          onAttach={onAttach}
          onDetach={onDetach}
          onFlush={onFlush}
          leadId={lead.id}
          busy={busy}
          senderEmail={senderEmail}
        />
      ) : (
        <PreviewStep
          lead={lead}
          steps={steps}
          onLaunch={() => void launch()}
          launching={busy}
        />
      )}
    </div>
  )
}
