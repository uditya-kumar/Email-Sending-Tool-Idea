import { useState } from "react"
import { FileText, Mail } from "lucide-react"
import { Input } from "@/components/ui/input"
import { SequenceSidebar } from "@/components/compose/SequenceSidebar"
import { EmailEditor } from "@/components/compose/EmailEditor"
import { SendTestPopover } from "@/components/compose/SendTestPopover"
import { TemplateSidebar } from "./TemplateSidebar"
import { RenameTemplateDialog } from "./RenameTemplateDialog"
import { newTemplate } from "@/lib/mock-data"
import {
  appendFollowUp,
  describeSequence,
  duplicateEmailStep,
  patchStep,
  removeEmailStep,
  setDelayDays,
} from "@/lib/sequence"
import type { EmailTemplate, SequenceStep } from "@/lib/types"

interface TemplatesPageProps {
  templates: EmailTemplate[]
  onChange: (templates: EmailTemplate[]) => void
  /** Connected Gmail address — the test send needs one to send from. */
  senderEmail?: string
}

/**
 * Templates page — a template is a whole sequence blueprint (opening email, waits,
 * follow-ups). Uses the same sequence rail + editor canvas as the compose Content
 * step, so writing a template is identical to writing a recipient's emails.
 */
export function TemplatesPage({
  templates,
  onChange,
  senderEmail,
}: TemplatesPageProps) {
  const [activeTemplateId, setActiveTemplateId] = useState(
    () => templates[0]?.id ?? ""
  )
  const [activeStepId, setActiveStepId] = useState(
    () => templates[0]?.steps.find((s) => s.kind === "email")?.id ?? ""
  )
  /** Which template the rename dialog is open for (null = closed). */
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const template = templates.find((t) => t.id === activeTemplateId) ?? null
  const steps = template?.steps ?? []
  const activeStep = steps.find((s) => s.id === activeStepId && s.kind === "email")
  const isFollowUp = activeStep
    ? activeStep.name.toLowerCase().includes("follow")
    : false

  /** Switch templates and land on that template's first email. */
  function selectTemplate(id: string) {
    setActiveTemplateId(id)
    const next = templates.find((t) => t.id === id)
    setActiveStepId(next?.steps.find((s) => s.kind === "email")?.id ?? "")
  }

  function setSteps(next: SequenceStep[]) {
    if (!template) return
    onChange(
      templates.map((t) => (t.id === template.id ? { ...t, steps: next } : t))
    )
  }

  /** Rename any template by id — the header field and the rail menu share this. */
  function rename(id: string, name: string) {
    onChange(templates.map((t) => (t.id === id ? { ...t, name } : t)))
  }

  function addTemplate() {
    const created = newTemplate(`tpl-${templates.length + 1}-${templates.length}`)
    onChange([...templates, created])
    setActiveTemplateId(created.id)
    setActiveStepId(created.steps[0].id)
  }

  function duplicateTemplate(id: string) {
    const idx = templates.findIndex((t) => t.id === id)
    if (idx === -1) return
    const source = templates[idx]
    const newId = `tpl-copy-${templates.length}-${id}`
    const copy: EmailTemplate = {
      id: newId,
      name: `${source.name} (copy)`,
      // Re-key steps so the copy's steps don't collide with the original's.
      steps: source.steps.map((s, i) => ({ ...s, id: `${newId}-${i}` })),
    }
    const next = [...templates]
    next.splice(idx + 1, 0, copy)
    onChange(next)
    setActiveTemplateId(copy.id)
    setActiveStepId(copy.steps.find((s) => s.kind === "email")?.id ?? "")
  }

  function deleteTemplate(id: string) {
    const next = templates.filter((t) => t.id !== id)
    onChange(next)
    if (id === activeTemplateId) {
      const fallback = next[0]
      setActiveTemplateId(fallback?.id ?? "")
      setActiveStepId(fallback?.steps.find((s) => s.kind === "email")?.id ?? "")
    }
  }

  function addStep() {
    if (!template) return
    const { steps: next, newStepId } = appendFollowUp(steps, template.id)
    setSteps(next)
    setActiveStepId(newStepId)
  }

  function deleteStep(id: string) {
    const next = removeEmailStep(steps, id)
    if (id === activeStepId) {
      setActiveStepId(next.find((s) => s.kind === "email")?.id ?? "")
    }
    setSteps(next)
  }

  return (
    <div className="flex min-h-0 flex-1">
      <TemplateSidebar
        templates={templates}
        activeId={activeTemplateId}
        onSelect={selectTemplate}
        onAdd={addTemplate}
        onRename={setRenamingId}
        onDuplicate={duplicateTemplate}
        onDelete={deleteTemplate}
      />

      <RenameTemplateDialog
        template={templates.find((t) => t.id === renamingId) ?? null}
        onOpenChange={(open) => !open && setRenamingId(null)}
        onSave={(name) => renamingId && rename(renamingId, name)}
      />

      {template ? (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Template name + sequence summary */}
          <div className="flex items-center gap-2 border-b bg-background px-4 py-2.5">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={template.name}
              onChange={(e) => rename(template.id, e.target.value)}
              placeholder="Template name"
              aria-label="Template name"
              className="h-8 max-w-sm border-0 px-0 text-[15px] font-semibold text-foreground shadow-none focus-visible:ring-0"
            />
            <span className="ml-auto text-sm text-muted-foreground">
              {describeSequence(steps)}
            </span>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Same rail as compose: emails + the waits between them. */}
            <SequenceSidebar
              steps={steps}
              activeStepId={activeStepId}
              onSelect={setActiveStepId}
              onAddStep={addStep}
              onDuplicateStep={(id) => setSteps(duplicateEmailStep(steps, id))}
              onDeleteStep={deleteStep}
              onChangeDelay={(id, days) => setSteps(setDelayDays(steps, id, days))}
            />

            {/* Dotted canvas — same as the compose Content step. */}
            <div className="canvas-dots flex-1 overflow-y-auto p-6">
              {activeStep ? (
                <div className="mx-auto max-w-3xl space-y-4">
                  {/* Email header card */}
                  <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 font-medium text-foreground shadow-sm">
                    <Mail className="size-4 text-muted-foreground" />
                    {activeStep.name}
                  </div>

                  {/* Compose card */}
                  <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
                    <div className="flex items-center gap-2 border-b px-4 py-3">
                      <span className="text-sm font-medium text-muted-foreground">
                        Subject:
                      </span>
                      <Input
                        value={activeStep.subject ?? ""}
                        onChange={(e) =>
                          setSteps(
                            patchStep(steps, activeStep.id, {
                              subject: e.target.value,
                            })
                          )
                        }
                        placeholder={
                          isFollowUp
                            ? "Leave it blank to send as a reply to your previous email"
                            : "Write a subject line…"
                        }
                        className="h-8 flex-1 border-0 px-0 text-foreground shadow-none focus-visible:ring-0"
                      />
                      <SendTestPopover senderEmail={senderEmail} />
                    </div>

                    <EmailEditor
                      key={activeStep.id}
                      bodyHtml={activeStep.bodyHtml ?? ""}
                      onChange={(html) =>
                        setSteps(patchStep(steps, activeStep.id, { bodyHtml: html }))
                      }
                    />
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Merge tags like{" "}
                    <code className="rounded bg-muted px-1 py-0.5">
                      {'{{first_name:"there"}}'}
                    </code>{" "}
                    are filled in per recipient when you send.
                  </p>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  Select an email step to edit its content.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          Create a template to get started.
        </div>
      )}
    </div>
  )
}
