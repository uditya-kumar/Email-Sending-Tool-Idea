import { useCallback, useEffect, useRef, useState } from "react"
import { stepsFromTemplate } from "@shared/sequence.ts"
import type {
  EmailTemplate,
  SequencesByLead,
  SequenceStep,
  StepAttachment,
} from "@shared/types.ts"
import { attachFileToStep, linkAttachmentsToStep, removeAttachment } from "./attachments"
import {
  fetchAllSequences,
  isPersistedStepId,
  saveSequence,
  saveStepContent,
} from "./sequences"

/**
 * Per-recipient sequences, backed by `sequence_steps`.
 *
 * The two-schedule split is the same as `useTemplates`, and for the same reason:
 *
 *  - **Structural** changes (add / delete / reorder / apply a template) write
 *    immediately through `saveSequence`, because Postgres assigns the ids of new
 *    rows and the editor needs them back. A step whose id is still a placeholder
 *    cannot be test-sent or launched.
 *  - **Content** changes (subject, body) are debounced and flushed by `flush()`.
 *
 * `flush()` is what keeps the launch and test-send buttons honest — both re-read
 * the row from the database, so an unflushed edit is simply not in the email.
 */

/** Long enough to coalesce a burst of typing, short enough to feel saved. */
const SAVE_DEBOUNCE_MS = 800

export interface SequencesStore {
  sequences: SequencesByLead
  loading: boolean
  /** A failed *read*. Write failures go to the `onError` callback. */
  error: string | null
  /** Local-only edit of one step's content; persisted on a debounce. */
  editStep: (leadId: string, stepId: string, patch: Partial<SequenceStep>) => void
  /**
   * Replace a lead's whole step list and adopt the ids Postgres assigns. Await it
   * — the returned list, not the one passed in, is the one that can be sent.
   */
  setSteps: (leadId: string, steps: SequenceStep[]) => Promise<SequenceStep[]>
  /**
   * Drop a template onto a lead: its text **and** its attached files.
   *
   * More than `setSteps(stepsFromTemplate(…))` because the files live in a join
   * table rather than on the step, so they have to be linked to the rows *after*
   * Postgres has assigned their ids. Carrying them across is the entire point of
   * template attachments — one resume uploaded to the "AI role" template, applied to
   * every recipient without picking the file again.
   */
  applyTemplate: (leadId: string, template: EmailTemplate) => Promise<SequenceStep[]>
  /**
   * Drop a deleted lead's steps from local state.
   *
   * No request: `sequence_steps.lead_id` is `on delete cascade`, so the rows are
   * already gone. This only stops a stale entry sitting in memory keyed to a lead
   * that no longer exists — and, more importantly, stops a queued content save
   * firing at one of its rows.
   */
  forget: (leadId: string) => void
  /**
   * Upload a file and attach it to one **persisted** email step.
   *
   * Not routed through `editStep`: attachments are three rows in other tables, not
   * a column on the step, so there is nothing for the debounced content save to
   * write. Resolves once the file is genuinely part of the email; rejects with a
   * message meant to be shown, having already unwound whatever it created.
   */
  attach: (leadId: string, stepId: string, file: File) => Promise<void>
  /** Detach a file and delete it. Await it — the removal is immediate. */
  detach: (leadId: string, stepId: string, attachment: StepAttachment) => Promise<void>
  /** Write any pending debounced edits now. Await before launching or test-sending. */
  flush: () => Promise<void>
}

export function useSequences(onError: (message: string) => void): SequencesStore {
  const [sequences, setSequences] = useState<SequencesByLead>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * Pending content saves, keyed by step id so several edited steps are each
   * written once. A ref rather than state: it must not re-render, and `flush` has
   * to see the latest value rather than a closed-over snapshot.
   */
  const pending = useRef(new Map<string, { step: SequenceStep; position: number }>())
  const timer = useRef<number | null>(null)

  /*
   * `onError` behind a ref so the debounce callbacks don't depend on it — callers
   * pass an inline arrow, which would otherwise rebuild `flush` every render and
   * restart the timer, so a user who keeps typing would never get a save.
   *
   * Assigned in an effect rather than during render: mutating a ref while
   * rendering is unsafe under concurrent rendering.
   */
  const report = useRef(onError)

  useEffect(() => {
    report.current = onError
  }, [onError])

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }

    const queued = [...pending.current.values()]
    pending.current.clear()

    // Sequential: a handful of small updates, and one failing shouldn't leave the
    // others' outcome ambiguous.
    for (const { step, position } of queued) {
      try {
        await saveStepContent(step, position)
      } catch (cause) {
        report.current(
          cause instanceof Error ? cause.message : "Couldn't save the email."
        )
      }
    }
  }, [])

  useEffect(() => {
    // Guards a resolved read landing after unmount, and StrictMode's double-mount.
    let active = true

    fetchAllSequences()
      .then((rows) => {
        if (!active) return
        setSequences(rows)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : "Couldn't load your sequences.")
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  /*
   * Flush on unmount and on tab close. The last edit before navigating away is
   * exactly the one a debounce loses.
   */
  useEffect(() => {
    const onHide = () => void flush()
    window.addEventListener("pagehide", onHide)

    return () => {
      window.removeEventListener("pagehide", onHide)
      void flush()
    }
  }, [flush])

  const editStep = useCallback(
    (leadId: string, stepId: string, patch: Partial<SequenceStep>) => {
      setSequences((prev) => {
        const steps = prev[leadId]
        if (!steps) return prev

        const next = steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s))
        const position = next.findIndex((s) => s.id === stepId)
        const updated = next[position]

        /*
         * Queue from the *merged* step rather than the patch: `saveStepContent`
         * writes whole columns, so a patch alone would blank the fields it doesn't
         * mention. Skipped entirely for a step that has no database row yet — the
         * write would 404 on its own placeholder id, and `setSteps` is what turns
         * such a step into a real one.
         */
        if (updated && isPersistedStepId(stepId)) {
          pending.current.set(stepId, { step: updated, position })
        }

        return { ...prev, [leadId]: next }
      })

      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [flush]
  )

  const setSteps = useCallback(
    async (leadId: string, steps: SequenceStep[]): Promise<SequenceStep[]> => {
      /*
       * Flush first. `saveSequence` deletes the rows that are gone, so a queued
       * content save aimed at one of them would either fail or write to a row about
       * to vanish — and for a surviving step, a write landing *after* the upsert
       * would be lost to it.
       */
      await flush()

      /*
       * Shown immediately, then reconciled with what came back. Structural edits go
       * through a round trip, and without this the sidebar wouldn't show a new
       * follow-up until the insert resolved.
       */
      setSequences((prev) => ({ ...prev, [leadId]: steps }))

      try {
        const saved = await saveSequence(leadId, steps)
        setSequences((prev) => ({ ...prev, [leadId]: saved }))
        return saved
      } catch (cause) {
        report.current(cause instanceof Error ? cause.message : "Couldn't save the sequence.")
        /*
         * The optimistic list stays on screen deliberately — it holds the user's
         * unsaved work, and reverting would discard the very edit that failed. The
         * placeholder ids in it are what block a launch, which is the correct
         * outcome for a sequence that isn't saved.
         */
        return steps
      }
    },
    [flush]
  )

  /**
   * Rewrite one step's attachment list in place.
   *
   * A functional update rather than a read of `sequences`, so an upload that
   * resolves after an unrelated edit doesn't reinstate the older list.
   */
  const putAttachments = useCallback(
    (leadId: string, stepId: string, next: (current: StepAttachment[]) => StepAttachment[]) => {
      setSequences((prev) => {
        const steps = prev[leadId]
        if (!steps) return prev

        return {
          ...prev,
          [leadId]: steps.map((step) =>
            step.id === stepId ? { ...step, attachments: next(step.attachments ?? []) } : step
          ),
        }
      })
    },
    []
  )

  const attach = useCallback(
    async (leadId: string, stepId: string, file: File) => {
      /*
       * `step_attachments.step_id` is a foreign key, so a placeholder id would fail
       * with a 23503 the user can't act on. In practice the compose flow persists a
       * lead's steps on open, so this is a guard rather than a path.
       */
      if (!isPersistedStepId(stepId)) {
        throw new Error("Save the email before attaching a file to it.")
      }

      /*
       * The step's current total, because the size limit is per message — see
       * `MAX_ATTACHMENT_BYTES`. Read from the live map rather than passed in by the
       * component, so the check can't be bypassed by a stale prop.
       */
      const attached = (sequences[leadId] ?? [])
        .find((step) => step.id === stepId)
        ?.attachments ?? []
      const attachedBytes = attached.reduce((sum, file) => sum + file.sizeBytes, 0)

      /*
       * No optimistic insert: there is nothing to show until the upload finishes
       * (no id, no size on the server's terms), and a file that appears and then
       * vanishes reads as data loss rather than as a rejected upload.
       */
      const saved = await attachFileToStep(stepId, file, attachedBytes)

      putAttachments(leadId, stepId, (current) =>
        [...current, saved].sort((a, b) => a.filename.localeCompare(b.filename))
      )
    },
    [putAttachments, sequences]
  )

  const detach = useCallback(
    async (leadId: string, stepId: string, attachment: StepAttachment) => {
      // Only deletes the stored file if no other step still references it — a file
      // that arrived from a template is shared with the template and every other
      // recipient it was applied to. See `removeAttachment`.
      await removeAttachment(attachment, stepId)
      putAttachments(leadId, stepId, (current) =>
        current.filter((file) => file.id !== attachment.id)
      )
    },
    [putAttachments]
  )

  const applyTemplate = useCallback(
    async (leadId: string, template: EmailTemplate): Promise<SequenceStep[]> => {
      /*
       * The text first. `stepsFromTemplate` re-keys every id to a placeholder, so
       * `saveSequence` inserts new rows and hands back their real ids — which is
       * exactly what the links below need, and why this can't be one pass.
       */
      const saved = await setSteps(leadId, stepsFromTemplate(template, leadId))

      /*
       * Paired by index, not by id: a template step and the lead's copy are different
       * rows in different tables by design, and the index is what `stepsFromTemplate`
       * preserves. Both lists are position-ordered — the template's sorted on read,
       * the saved one on write.
       *
       * A short `saved` list means the save partly failed; the `kind` and
       * `isPersistedStepId` checks then link nothing rather than risk attaching a
       * resume to the wrong email.
       */
      const files = new Map<string, StepAttachment[]>()

      for (const [i, step] of saved.entries()) {
        const source = template.steps[i]
        if (!source || step.kind !== "email" || source.kind !== "email") continue
        if (!isPersistedStepId(step.id)) continue

        const attachments = source.attachments ?? []
        if (attachments.length > 0) files.set(step.id, attachments)
      }

      if (files.size === 0) return saved

      try {
        /*
         * Links the *same* `attachments` rows rather than re-uploading — see
         * `linkAttachmentsToStep`. Sequential so a failure reports as itself.
         */
        for (const [stepId, attachments] of files) {
          await linkAttachmentsToStep(stepId, attachments.map((f) => f.id))
        }
      } catch (cause) {
        /*
         * Reported rather than thrown: the steps themselves saved, and the user's
         * template is applied. Only the files are missing, and they can be attached by
         * hand — whereas throwing here would also lose the toast the caller shows.
         */
        report.current(
          cause instanceof Error ? cause.message : "Couldn't copy the template's files."
        )
        return saved
      }

      /*
       * Shown from the template's own lists rather than re-read. They are literally the
       * same `attachments` rows, so a round trip would only tell us what we already
       * have.
       */
      const withFiles = saved.map((step) => {
        const attachments = files.get(step.id)
        return attachments ? { ...step, attachments } : step
      })

      setSequences((prev) => ({ ...prev, [leadId]: withFiles }))

      return withFiles
    },
    [setSteps]
  )

  const forget = useCallback((leadId: string) => {
    setSequences((prev) => {
      const steps = prev[leadId]
      if (!steps) return prev

      // Drop queued writes for these steps first — the rows are already gone, so a
      // flush would report a failure for something the user asked for.
      for (const step of steps) pending.current.delete(step.id)

      const next = { ...prev }
      delete next[leadId]
      return next
    })
  }, [])

  return {
    sequences,
    loading,
    error,
    editStep,
    setSteps,
    applyTemplate,
    forget,
    attach,
    detach,
    flush,
  }
}
