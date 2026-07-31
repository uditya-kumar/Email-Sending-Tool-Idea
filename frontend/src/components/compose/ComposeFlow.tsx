import { useState } from "react"
import { toast } from "sonner"
import { ComposeHeader } from "./ComposeHeader"
import { ContentStep } from "./ContentStep"
import { PreviewStep } from "./PreviewStep"
import type { ComposeStep, Lead, SequenceStep } from "@/lib/types"

interface ComposeFlowProps {
  lead: Lead
  steps: SequenceStep[]
  onStepsChange: (steps: SequenceStep[]) => void
  onLeadChange: (patch: Partial<Lead>) => void
  onLaunch: () => void
  onBack: () => void
}

/**
 * The per-recipient send flow opened from a Database row:
 * Content → Preview, with Launch available on Preview only.
 */
export function ComposeFlow({
  lead,
  steps,
  onStepsChange,
  onLeadChange,
  onLaunch,
  onBack,
}: ComposeFlowProps) {
  const [step, setStep] = useState<ComposeStep>("content")
  const [activeStepId, setActiveStepId] = useState(
    () => steps.find((s) => s.kind === "email")?.id ?? ""
  )

  const contentReady = steps.some(
    (s) => s.kind === "email" && (s.subject || s.bodyHtml)
  )

  function updateStep(id: string, patch: Partial<SequenceStep>) {
    onStepsChange(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function addStep() {
    const followCount = steps.filter((s) =>
      s.name.toLowerCase().includes("follow")
    ).length
    const stamp = `${lead.id}-${steps.length}-${followCount}`
    const delay: SequenceStep = {
      id: `delay-${stamp}`,
      kind: "delay",
      name: "Wait",
      waitDays: 3,
    }
    const email: SequenceStep = {
      id: `email-${stamp}`,
      kind: "email",
      name: `Follow-up #${followCount + 1}`,
      subject: "",
      bodyHtml: "",
      abTest: false,
    }
    onStepsChange([...steps, delay, email])
    setActiveStepId(email.id)
  }

  function duplicateStep(id: string) {
    const idx = steps.findIndex((s) => s.id === id)
    if (idx === -1) return
    const original = steps[idx]
    const copy: SequenceStep = {
      ...original,
      id: `email-copy-${steps.length}-${id}`,
      name: `${original.name} (copy)`,
    }
    const delay: SequenceStep = {
      id: `delay-copy-${steps.length}-${id}`,
      kind: "delay",
      name: "Wait",
      waitDays: 3,
    }
    const next = [...steps]
    next.splice(idx + 1, 0, delay, copy)
    onStepsChange(next)
  }

  function deleteStep(id: string) {
    const idx = steps.findIndex((s) => s.id === id)
    if (idx === -1) return
    // Also drop the delay immediately preceding this email step, if any.
    const start = idx > 0 && steps[idx - 1].kind === "delay" ? idx - 1 : idx
    const next = steps.filter((_, i) => i < start || i > idx)
    if (id === activeStepId) {
      const nextEmail = next.find((s) => s.kind === "email")
      setActiveStepId(nextEmail?.id ?? "")
    }
    onStepsChange(next)
  }

  function changeDelay(id: string, waitDays: number) {
    onStepsChange(steps.map((s) => (s.id === id ? { ...s, waitDays } : s)))
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
          activeStepId={activeStepId}
          onSelectStep={setActiveStepId}
          onUpdateStep={updateStep}
          onAddStep={addStep}
          onGenerate={() => toast.info("AI sequence generation is coming soon.")}
          onDuplicateStep={duplicateStep}
          onDeleteStep={deleteStep}
          onChangeDelay={changeDelay}
          onChangeSendTime={(hhmm) => onLeadChange({ sendTimeIST: hhmm })}
        />
      ) : (
        <PreviewStep lead={lead} steps={steps} onLaunch={onLaunch} />
      )}
    </div>
  )
}
