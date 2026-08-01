import { useState } from "react"
import { toast } from "sonner"
import { ComposeHeader } from "./ComposeHeader"
import { ContentStep } from "./ContentStep"
import { PreviewStep } from "./PreviewStep"
import { fullName } from "@/lib/leads"
import { stepsFromTemplate } from "@/lib/mock-data"
import {
  appendFollowUp,
  describeSequence,
  duplicateEmailStep,
  patchStep,
  removeEmailStep,
  setDelayDays,
} from "@/lib/sequence"
import type {
  ComposeStep,
  EmailTemplate,
  Lead,
  SequenceStep,
} from "@/lib/types"

interface ComposeFlowProps {
  lead: Lead
  steps: SequenceStep[]
  onStepsChange: (steps: SequenceStep[]) => void
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
  onLaunch: () => void
  onBack: () => void
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
  templates,
  onChangeSendTime,
  onLaunch,
  onBack,
  senderEmail,
}: ComposeFlowProps) {
  const [step, setStep] = useState<ComposeStep>("content")
  const [activeStepId, setActiveStepId] = useState(
    () => steps.find((s) => s.kind === "email")?.id ?? ""
  )

  const contentReady = steps.some(
    (s) => s.kind === "email" && (s.subject || s.bodyHtml)
  )

  function addStep() {
    const { steps: next, newStepId } = appendFollowUp(steps, lead.id)
    onStepsChange(next)
    setActiveStepId(newStepId)
  }

  function deleteStep(id: string) {
    const next = removeEmailStep(steps, id)
    if (id === activeStepId) {
      setActiveStepId(next.find((s) => s.kind === "email")?.id ?? "")
    }
    onStepsChange(next)
  }

  /** Drop a saved template in wholesale: every email, follow-up and wait. */
  function applyTemplate(template: EmailTemplate) {
    const next = stepsFromTemplate(template, lead.id)
    onStepsChange(next)
    setActiveStepId(next.find((s) => s.kind === "email")?.id ?? "")
    toast.success(`Applied "${template.name}"`, {
      description: `${describeSequence(next)} — edit anything below for ${
        fullName(lead) || lead.email
      }.`,
    })
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
          onApplyTemplate={applyTemplate}
          activeStepId={activeStepId}
          onSelectStep={setActiveStepId}
          onUpdateStep={(id, patch) => onStepsChange(patchStep(steps, id, patch))}
          onAddStep={addStep}
          onDuplicateStep={(id) => onStepsChange(duplicateEmailStep(steps, id))}
          onDeleteStep={deleteStep}
          onChangeDelay={(id, days) => onStepsChange(setDelayDays(steps, id, days))}
          onChangeSendTime={onChangeSendTime}
          senderEmail={senderEmail}
        />
      ) : (
        <PreviewStep lead={lead} steps={steps} onLaunch={onLaunch} />
      )}
    </div>
  )
}
