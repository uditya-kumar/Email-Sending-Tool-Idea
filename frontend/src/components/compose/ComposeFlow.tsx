import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { projectSequenceSchedule } from "@shared/schedule.ts"
import { ComposeHeader } from "./ComposeHeader"
import { ContentStep } from "./ContentStep"
import { PreviewStep } from "./PreviewStep"
import { resyncSchedule } from "@/lib/api"
import { fullName } from "@/lib/leads"
import { useSends } from "@/lib/sends"
import { isPersistedStepId } from "@/lib/sequences"
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

/**
 * How long after the last +/- click to re-time the queued send.
 *
 * Longer than it needs to be for one click and shorter than a deliberate pause:
 * the point is that holding the button through 1→5 fires one round trip, not five.
 * Kept under `useSequences`'s own 800ms content debounce so the sequence is
 * flush-then-resync in one hop rather than two waits stacked end to end.
 */
const RESYNC_DEBOUNCE_MS = 500

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
  /** A connected Gmail address — gates the test send and prefills its recipient. */
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
   * A pending trailing resync, so a burst of +/- clicks re-times the queue once at
   * the end instead of once per click.
   *
   * The resync is a server round trip that re-reads `sequence_steps` and rewrites
   * `sends.scheduled_at`, and only its **last** answer can be right while the user
   * is still clicking — every earlier one computes from a wait that has already been
   * superseded. Debouncing it is therefore not just cheaper, it removes a race.
   *
   * A ref, not state: the timer id must never cause a render, and the cleanup below
   * has to see the latest value rather than a closed-over one.
   */
  const resyncTimer = useRef<number | null>(null)

  /*
   * Run a still-pending resync on unmount, and on a lead change (`ComposeFlow` is
   * keyed by lead id, so switching recipients unmounts this one).
   *
   * Without this, closing the editor within the debounce window after a wait change
   * leaves the queued send on its old date: the step edit is saved — `useSequences`
   * flushes on unmount too — but nothing ever tells the server to re-time the row,
   * and the rail would then disagree with the queue on reopening.
   *
   * `onFlush` first, for the same reason as in `resyncSoon`, and this is the case
   * that needs it most: both debounces are cut short here, so the content write is
   * certainly still pending. Fire-and-forget — the component is going away and there
   * is nothing left to render an outcome into. `sendsStore.refresh` is skipped for
   * the same reason.
   *
   * Neither callback is in the dependency list: both are redeclared every render, so
   * depending on them would tear down and re-create the effect constantly. What they
   * close over that matters here — `lead.id` — cannot change without a remount.
   */
  useEffect(
    () => () => {
      if (resyncTimer.current === null) return
      window.clearTimeout(resyncTimer.current)
      resyncTimer.current = null

      void onFlush()
        .then(() => resyncSchedule(lead.id))
        .catch((cause: unknown) => {
          console.warn("Couldn't re-time the queued send on close", cause)
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lead.id]
  )

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
   * `resync`, but only after the user stops clicking — and only once the edit behind
   * it is actually in the database.
   *
   * For the +/- buttons, which get nudged several times in a row. Each click already
   * shows its new dates immediately (the rail projects from `steps`), so the round
   * trip behind it has nothing to contribute until the number settles.
   *
   * The flush is not optional, and it is the same trap `changeSendTime` documents one
   * level down: `resync-schedule` re-reads `sequence_steps` to decide the new time,
   * so a resync that overtakes the debounced write would read the *old* wait, compute
   * the date the row already has, and move nothing — leaving the queue on a date the
   * rail has stopped showing. Awaiting the flush makes this correct regardless of how
   * the two debounce windows compare.
   */
  function resyncSoon() {
    if (resyncTimer.current !== null) window.clearTimeout(resyncTimer.current)

    resyncTimer.current = window.setTimeout(() => {
      resyncTimer.current = null
      void onFlush().then(() => resync())
    }, RESYNC_DEBOUNCE_MS)
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
   * Changing a wait: local and instant, saved on a debounce, resynced after that.
   *
   * Deliberately **not** `onStepsChange`. That path is for edits that change the
   * *shape* of the list — it flushes, deletes the rows that are gone, upserts every
   * step, reads them back, and replaces local state with the result. All of which a
   * wait change needs none of: it is one integer on one row that already exists.
   *
   * The read-back is what made the buttons stutter. Clicking 1→5 quickly puts five
   * whole-list saves in flight, and they resolve in whatever order the network
   * chooses — so the response carrying `4` lands after the optimistic `5` and stamps
   * `4` back onto the screen. That is the jitter: not a slow update, but a correct
   * one being overwritten by a stale reply. `onEditStep` has no read-back at all, so
   * there is nothing left to arrive late and contradict what the user sees. It also
   * coalesces, turning a five-click burst into one UPDATE instead of five
   * delete-upsert-select round trips.
   *
   * Safe on the two counts `onStepsChange` exists for. Ids: a wait card can only be
   * clicked on a step that is already rendered from the database, and the guard below
   * makes that explicit rather than assumed. Positions: nothing moves, so there is
   * no renumber to collide with the deferred `(lead_id, position)` constraint —
   * `saveStepContent` writes every column *except* `position` for exactly this
   * reason.
   *
   * The dates update on this render rather than when the write returns:
   * `projectSequenceSchedule` derives from `steps`, and `onEditStep` has already
   * changed that. `resyncSoon` then moves the queued row to the date on screen —
   * once, after the clicking stops.
   */
  function changeDelay(id: string, days: number) {
    /*
     * A delay step with a placeholder id has never been saved, so there is no row for
     * the debounced write to update — `editStep` would drop it silently and the wait
     * would revert on the next read. Falling back to the whole-list save is what
     * turns it into a real row. Not reachable today (a wait only appears alongside
     * the follow-up whose insert created it), and cheap insurance against it becoming
     * reachable.
     */
    if (!isPersistedStepId(id)) {
      void onStepsChange(setDelayDays(steps, id, days)).then(() => resync())
      return
    }

    onEditStep(id, { waitDays: days })
    resyncSoon()
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
