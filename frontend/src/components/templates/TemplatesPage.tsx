import { useState } from "react"
import { FileText, Loader2, Mail } from "lucide-react"
import { Input } from "@/components/ui/input"
import { AttachmentBar } from "@/components/compose/AttachmentBar"
import { SequenceSidebar } from "@/components/compose/SequenceSidebar"
import { EmailEditor } from "@/components/compose/EmailEditor"
import { SendTestPopover } from "@/components/compose/SendTestPopover"
import { useSubjectInsert } from "@/components/compose/use-subject-insert"
import { TemplateSidebar } from "./TemplateSidebar"
import { RenameTemplateDialog } from "./RenameTemplateDialog"
import {
  appendFollowUp,
  describeSequence,
  duplicateEmailStep,
  removeEmailStep,
  setDelayDays,
} from "@/lib/sequence"
import type { SequenceStep } from "@/lib/types"
import type { TemplatesStore } from "@/lib/use-templates"

interface TemplatesPageProps {
  /** Templates plus their persistence — see `useTemplates`. */
  store: TemplatesStore
  /** Connected Gmail address — the test send needs one to send from. */
  senderEmail?: string | undefined
}

/**
 * Templates page — a template is a whole sequence blueprint (opening email, waits,
 * follow-ups). Uses the same sequence rail + editor canvas as the compose Content
 * step, so writing a template is identical to writing a recipient's emails.
 *
 * Step ids here are real `template_steps` UUIDs, which is what lets the test-send
 * button work: the server resolves the step by id and renders the stored row.
 */
export function TemplatesPage({ store, senderEmail }: TemplatesPageProps) {
  const { templates, loading, error } = store

  /**
   * What the user has *chosen*, which is not the same as what's shown.
   *
   * Both are resolved against the current list below rather than kept in sync with
   * it by an effect. That matters more than it looks: templates arrive
   * asynchronously (so on first render there is nothing to select), and a new step
   * is selected before it has the id Postgres will give it — so a chosen id
   * routinely doesn't exist. Deriving the effective selection means both cases fall
   * out for free, instead of each needing its own corrective effect that renders one
   * wrong frame before fixing itself.
   */
  const [chosenTemplateId, setChosenTemplateId] = useState("")
  const [chosenStepId, setChosenStepId] = useState("")
  /** Which template the rename dialog is open for (null = closed). */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  /**
   * True while a structural save is in flight.
   *
   * Only used to hold the attachment control: a step added or reordered mid-upload
   * can be written with a different id, and the link would then point at a row the
   * editor no longer shows.
   */
  const [busy, setBusy] = useState(false)

  const template =
    templates.find((t) => t.id === chosenTemplateId) ?? templates[0] ?? null
  const steps = template?.steps ?? []

  const activeStep =
    steps.find((s) => s.id === chosenStepId && s.kind === "email") ??
    steps.find((s) => s.kind === "email")

  const activeTemplateId = template?.id ?? ""
  const activeStepId = activeStep?.id ?? ""

  const isFollowUp = activeStep
    ? activeStep.name.toLowerCase().includes("follow")
    : false

  /*
   * Same subject/body pair as the compose Content step, so it gets the same
   * attribute-insert routing — the toolbar button can't see the subject field on its
   * own. Keyed on template *and* step: switching templates changes the subject under
   * it just as switching steps does.
   */
  const subjectInsert = useSubjectInsert({
    subject: activeStep?.subject ?? "",
    onChange: (subject) =>
      activeStep && store.editStep(activeTemplateId, activeStep.id, { subject }),
    resetKey: `${activeTemplateId}:${activeStepId}`,
  })

  /** Switch templates. The step falls back to that template's first email. */
  function selectTemplate(id: string) {
    setChosenTemplateId(id)
    setChosenStepId("")
  }

  async function addTemplate() {
    const created = await store.add()
    if (!created) return
    selectTemplate(created.id)
  }

  async function duplicateTemplate(id: string) {
    const copy = await store.duplicate(id)
    if (!copy) return
    selectTemplate(copy.id)
  }

  async function deleteTemplate(id: string) {
    await store.remove(id)
    // No need to pick a replacement — an id that no longer exists resolves to the
    // first remaining template on the next render.
  }

  /** Every structural write, so `busy` covers all of them rather than most. */
  async function runStructural(next: SequenceStep[]): Promise<SequenceStep[]> {
    if (!template) return steps
    setBusy(true)
    const saved = await store.setSteps(template.id, next)
    setBusy(false)
    return saved
  }

  async function addStep() {
    if (!template) return
    const { steps: next } = appendFollowUp(steps, template.id)
    const saved = await runStructural(next)
    // Select the new follow-up by position, not by the id `appendFollowUp`
    // invented — the persisted rows carry database-assigned ids instead.
    setChosenStepId(saved.filter((s) => s.kind === "email").at(-1)?.id ?? "")
  }

  async function deleteStep(id: string) {
    await runStructural(removeEmailStep(steps, id))
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
        {error}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <TemplateSidebar
        templates={templates}
        activeId={activeTemplateId}
        onSelect={selectTemplate}
        onAdd={() => void addTemplate()}
        onRename={setRenamingId}
        onDuplicate={(id) => void duplicateTemplate(id)}
        onDelete={(id) => void deleteTemplate(id)}
      />

      <RenameTemplateDialog
        template={templates.find((t) => t.id === renamingId) ?? null}
        onOpenChange={(open) => !open && setRenamingId(null)}
        onSave={(name) => renamingId && store.rename(renamingId, name)}
      />

      {template ? (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Template name + sequence summary */}
          <div className="flex items-center gap-2 border-b bg-background px-4 py-2.5">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={template.name}
              onChange={(e) => store.rename(template.id, e.target.value)}
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
              onSelect={setChosenStepId}
              onAddStep={() => void addStep()}
              onDuplicateStep={(id) => void runStructural(duplicateEmailStep(steps, id))}
              onDeleteStep={(id) => void deleteStep(id)}
              onChangeDelay={(id, days) =>
                void runStructural(setDelayDays(steps, id, days))
              }
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
                        {...subjectInsert.subjectProps}
                        value={activeStep.subject ?? ""}
                        onChange={(e) =>
                          store.editStep(template.id, activeStep.id, {
                            subject: e.target.value,
                          })
                        }
                        placeholder={
                          isFollowUp
                            ? "Leave it blank to send as a reply to your previous email"
                            : "Write a subject line…"
                        }
                        className="h-8 flex-1 border-0 px-0 text-foreground shadow-none focus-visible:ring-0"
                      />
                      {/*
                        No leadId — the Templates page has no recipient, so every
                        merge tag falls back to its own default. `onBeforeSend`
                        flushes the debounced editor saves, since the server renders
                        the stored row rather than anything sent in the request.
                      */}
                      <SendTestPopover
                        senderEmail={senderEmail}
                        stepId={activeStep.id}
                        onBeforeSend={store.flush}
                      />
                    </div>

                    <EmailEditor
                      key={activeStep.id}
                      bodyHtml={activeStep.bodyHtml ?? ""}
                      onChange={(html) =>
                        store.editStep(template.id, activeStep.id, { bodyHtml: html })
                      }
                      insertTarget={subjectInsert.insertTarget}
                      onInsertOutside={subjectInsert.insertIntoSubject}
                      onBodyFocus={subjectInsert.onBodyFocus}
                    />

                    {/*
                      Attached here, once, rather than per recipient: applying this
                      template copies these files onto the lead's steps too. One
                      resume per role, picked once.
                    */}
                    <AttachmentBar
                      attachments={activeStep.attachments}
                      onAttach={(file) => store.attach(template.id, activeStep.id, file)}
                      onDetach={(file) => store.detach(template.id, activeStep.id, file)}
                      disabled={busy}
                    />
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Merge tags like{" "}
                    <code className="rounded bg-muted px-1 py-0.5">
                      {'{{first_name:"there"}}'}
                    </code>{" "}
                    are filled in per recipient when you send. Attachments come along
                    when you apply this template to a recipient.
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
