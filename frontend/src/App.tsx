import { useMemo, useState } from "react"
import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import { WizardHeader } from "@/components/wizard/WizardHeader"
import { WizardTabs } from "@/components/wizard/WizardTabs"
import { AudienceStep } from "@/components/audience/AudienceStep"
import { ContentStep } from "@/components/content/ContentStep"
import { PreviewStep } from "@/components/preview/PreviewStep"
import { SettingsStep } from "@/components/settings/SettingsStep"
import { SenderPanel } from "@/components/settings/SenderPanel"
import {
  DEFAULT_SETTINGS,
  MOCK_LEADS,
  MOCK_SENDERS,
  MOCK_SEQUENCE,
} from "@/lib/mock-data"
import type {
  Lead,
  SenderAccount,
  SequenceSettings,
  SequenceStep,
  WizardTab,
} from "@/lib/types"

const TAB_ORDER: WizardTab[] = ["audience", "content", "preview", "settings"]

export default function App() {
  const [activeTab, setActiveTab] = useState<WizardTab>("content")
  const [leads, setLeads] = useState<Lead[]>(MOCK_LEADS)
  const [steps, setSteps] = useState<SequenceStep[]>(MOCK_SEQUENCE)
  const [activeStepId, setActiveStepId] = useState(MOCK_SEQUENCE[0].id)
  const [senders, setSenders] = useState<SenderAccount[]>(MOCK_SENDERS)
  const [settings, setSettings] = useState<SequenceSettings>(DEFAULT_SETTINGS)
  const [editingSenderId, setEditingSenderId] = useState<string | null>(null)

  const openingEmail = useMemo(
    () => steps.find((s) => s.kind === "email"),
    [steps]
  )

  const emailSteps = steps.filter((s) => s.kind === "email")
  const completed: Record<WizardTab, boolean> = {
    audience: leads.length > 0,
    content: emailSteps.some((s) => s.subject || s.bodyHtml),
    preview: leads.length > 0 && Boolean(openingEmail?.bodyHtml),
    settings: senders.length > 0,
  }

  const isLastTab = activeTab === "settings"

  function handlePrimary() {
    if (isLastTab) {
      toast.success("Sequence launched", {
        description: "Emails will be dispatched at each recipient's IST time.",
      })
      return
    }
    const idx = TAB_ORDER.indexOf(activeTab)
    setActiveTab(TAB_ORDER[idx + 1])
  }

  function updateStep(id: string, patch: Partial<SequenceStep>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function addStep() {
    const followCount = steps.filter((s) =>
      s.name.toLowerCase().includes("follow")
    ).length
    const stamp = leads.length + steps.length + followCount
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
    setSteps((prev) => [...prev, delay, email])
    setActiveStepId(email.id)
  }

  function duplicateStep(id: string) {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id)
      if (idx === -1) return prev
      const original = prev[idx]
      const copy: SequenceStep = {
        ...original,
        id: `email-copy-${prev.length}-${id}`,
        name: `${original.name} (copy)`,
      }
      const delay: SequenceStep = {
        id: `delay-copy-${prev.length}-${id}`,
        kind: "delay",
        name: "Wait",
        waitDays: 3,
      }
      const next = [...prev]
      next.splice(idx + 1, 0, delay, copy)
      return next
    })
  }

  function deleteStep(id: string) {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id)
      if (idx === -1) return prev
      // Also drop the delay immediately preceding this email step, if any.
      const start = idx > 0 && prev[idx - 1].kind === "delay" ? idx - 1 : idx
      const next = prev.filter((_, i) => i < start || i > idx)
      if (id === activeStepId) {
        const nextEmail = next.find((s) => s.kind === "email")
        if (nextEmail) setActiveStepId(nextEmail.id)
      }
      return next
    })
  }

  function changeDelay(id: string, waitDays: number) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, waitDays } : s)))
  }

  const editingSender = senders.find((s) => s.id === editingSenderId) ?? null

  return (
    <div className="flex h-svh flex-col bg-background">
      <WizardHeader
        sequenceName="New sequence 22-Jul-2026"
        savedLabel="Saved less than 5 seconds ago"
        primaryLabel={isLastTab ? "Launch sequence" : "Next"}
        primaryIsLaunch={isLastTab}
        onPrimary={handlePrimary}
      />
      <WizardTabs active={activeTab} onChange={setActiveTab} completed={completed} />

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === "audience" && (
          <div className="flex-1 overflow-y-auto">
            <AudienceStep leads={leads} onChange={setLeads} />
          </div>
        )}

        {activeTab === "content" && (
          <ContentStep
            steps={steps}
            activeStepId={activeStepId}
            onSelectStep={setActiveStepId}
            onUpdateStep={updateStep}
            onAddStep={addStep}
            onGenerate={() => toast.info("AI sequence generation is coming soon.")}
            onDuplicateStep={duplicateStep}
            onDeleteStep={deleteStep}
            onChangeDelay={changeDelay}
          />
        )}

        {activeTab === "preview" && (
          <PreviewStep leads={leads} openingEmail={openingEmail} />
        )}

        {activeTab === "settings" && (
          <div className="flex-1 overflow-y-auto">
            <SettingsStep
              senders={senders}
              settings={settings}
              onSettingsChange={(patch) =>
                setSettings((prev) => ({ ...prev, ...patch }))
              }
              onEditSender={(s) => setEditingSenderId(s.id)}
              onSaveSchedule={() => toast.success("Schedule saved")}
            />
          </div>
        )}
      </main>

      <SenderPanel
        sender={editingSender}
        onOpenChange={(open) => !open && setEditingSenderId(null)}
        onUpdate={(patch) =>
          setSenders((prev) =>
            prev.map((s) => (s.id === editingSenderId ? { ...s, ...patch } : s))
          )
        }
        sequenceName="New sequence 22-Jul-2026"
        recipientsAllocated={leads.length}
        emailsScheduled={0}
      />

      <Toaster position="bottom-right" />
    </div>
  )
}
