import { useState } from "react"
import { toast } from "sonner"
import { projectSequenceSchedule } from "@shared/schedule.ts"
import { ComposeHeader } from "./ComposeHeader"
import { ContentStep } from "./ContentStep"
import { PreviewStep } from "./PreviewStep"
import { resyncSchedule } from "@/lib/api"
import { fullName } from "@/lib/leads"
import { useSends } from "@/lib/sends"
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
  SequenceSettings,
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
   * Write any pending debounced send-time edit **now**.
   *
   * Needed because `onChangeSendTime` is optimistic and debounced, while the send
   * time is one of the two inputs to a follow-up's scheduled time — so re-timing a
   * queued send has to happen after the new time is actually in the database, not
   * 600ms before it.
   */
  onFlushSendTime: () => Promise<void>
  /**
   * Attach / detach a file on one step. Rejects with a message meant to be shown —
   * `AttachmentBar` reports it against the file it belongs to, which is why these
   * throw rather than route through the store's `onError`.
   */
  onAttach: (stepId: string, file: File) => Promise<void>
  onDetach: (stepId: string, attachment: StepAttachment) => Promise<void>
  /** Queue the opening email. Resolves when the server has answered. */
  onLaunch: () => Promise<void>
  /**
   * The weekday windows the scheduler will apply, so the projected send times in
   * the rail match what will actually happen.
   *
   * Passed in rather than read here: `useSettings` is one row shared by the whole
   * app, and a second copy of that hook would mean a second fetch of it every time
   * this flow opened.
   */
  settings: SequenceSettings
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
  onFlushSendTime,
  onAttach,
  onDetach,
  onLaunch,
  settings,
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

  /**
   * This recipient's queue rows — what the scheduler has actually committed to.
   * SELECT-only to the browser, so a row here is the server's word, not the UI's.
   */
  const sendsStore = useSends(lead.id)

  /**
   * When each email is due, and where the reply came in.
   *
   * Recomputed on every render rather than memoised, and that is the whole
   * mechanism behind "it updates when you change the wait": `steps` is the source,
   * so editing a wait card re-derives every following time on the same render as
   * the number changing — including the date on an already-queued follow-up, which
   * `desiredFollowUpTime` recomputes rather than reading the row's stale snapshot.
   * The resync below then makes the queue agree. It is pure arithmetic over a
   * handful of steps — a `useMemo` here would cost more in dependency bookkeeping
   * than it saves, and would need `now` in its dependency list to stay correct
   * anyway.
   */
  const { timings, replyAfterStepId } = projectSequenceSchedule({
    steps,
    sends: sendsStore.sends,
    sendTimeIST: lead.sendTimeIST,
    outreachDays: settings.outreachDays,
    followUpDays: settings.followUpDays,
    repliedAt: lead.repliedAt,
  })

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
    // Appending brings a wait with it, so the queued follow-up may have moved.
    await resync()
    setBusy(false)
    // Select the new follow-up by position, not by the id `appendFollowUp`
    // invented — the persisted rows carry database-assigned ids instead.
    setChosenStepId(saved.filter((s) => s.kind === "email").at(-1)?.id ?? "")
  }

  async function deleteStep(id: string) {
    setBusy(true)
    await onStepsChange(removeEmailStep(steps, id))
    // Removing a step takes its wait with it and renumbers everything after it.
    await resync()
    setBusy(false)
    // No replacement needed: an id that no longer exists resolves to the first
    // remaining email on the next render.
  }

  /**
   * Push an already-queued follow-up onto its new time, then re-read the queue.
   *
   * A queued send is a snapshot — `scheduled_at` was worked out from the wait that
   * was in force when the previous email went out — so changing a wait saves the
   * step but leaves the send row in its old slot, and the rail keeps showing the
   * old date because that row is genuinely what the scheduler will fire. This is
   * what closes that gap. `sends` is SELECT-only to the browser, so it has to be
   * the server that moves it.
   *
   * Failures are logged, not surfaced: the edit the user made has already been
   * saved, and a toast here would blame their wait change for a network problem.
   * The rail keeps showing the queued time, which is still the truth — a send that
   * wasn't moved really is still going out then.
   */
  async function resync() {
    // Nothing queued means nothing to move: an unlaunched lead's rail is entirely
    // projections, which already re-derive from `steps` as they change.
    if (sendsStore.sends.length === 0) return

    try {
      await resyncSchedule(lead.id)
    } catch (cause) {
      console.warn("Couldn't re-time the queued send", cause)
      return
    }

    await sendsStore.refresh()
  }

  /**
   * The send time is the other input to a queued follow-up's scheduled time, so
   * changing it leaves that row as stale as changing a wait does.
   *
   * The flush is the whole point of going through here: `onChangeSendTime` is
   * optimistic and debounced by 600ms, so a resync fired alongside it would read
   * the *old* time from the database, compute the time the row already has, and
   * move nothing — the bug this is fixing, one level down. `busy` is left alone:
   * this fires while the user is nudging a time input, and disabling the rail
   * under their cursor mid-edit would be worse than a rail that updates a beat
   * later.
   */
  async function changeSendTime(hhmm: string) {
    onChangeSendTime(hhmm)
    await onFlushSendTime()
    await resync()
  }

  async function runStructural(next: SequenceStep[]) {
    setBusy(true)
    await onStepsChange(next)
    /*
     * After the save, not in parallel with it: the server re-reads
     * `sequence_steps` to decide the new time, so it has to see the edit. Every
     * structural change routes through here — a changed wait moves the send, and
     * an added or deleted step renumbers positions, which decides *which* step
     * the queued row is even for.
     */
    await resync()
    setBusy(false)
  }

  /**
   * Changing a wait: shown immediately, saved and resynced behind it.
   *
   * Split out of `runStructural` because of `busy`. The others rebuild the step
   * list — adding or deleting renumbers positions, and a second click before the
   * read-back lands would compute from stale ones — so locking the rail is
   * protecting something real. A wait is just a number on one step: it can't
   * collide, and `setDelayDays` is applied to whatever the latest list is anyway.
   * Locking it made the +/- buttons unclickable for the length of a round trip,
   * which is precisely the control a user nudges several times in a row.
   *
   * The dates below update on this render, not when the write returns:
   * `onStepsChange` shows the new list optimistically and
   * `projectSequenceSchedule` re-derives from it — for the queued follow-up too,
   * which is why `desiredFollowUpTime` is shared rather than the row being trusted
   * verbatim. The resync then moves the row to the date already on screen.
   */
  async function changeDelay(id: string, days: number) {
    await onStepsChange(setDelayDays(steps, id, days))
    await resync()
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
    /*
     * Re-read the queue before clearing `busy`: the launch is what turns the
     * opening email from a projection into a committed row, and the two-minute poll
     * would otherwise leave the rail claiming "Sends ≈ tomorrow" for a send it has
     * just been told about. Not awaited inside a `try` because `onLaunch` already
     * reports its own failures — and a launch that failed has nothing new to read.
     */
    await sendsStore.refresh()
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
          onChangeDelay={(id, days) => void changeDelay(id, days)}
          onChangeSendTime={(hhmm) => void changeSendTime(hhmm)}
          timings={timings}
          replyAfterStepId={replyAfterStepId}
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
