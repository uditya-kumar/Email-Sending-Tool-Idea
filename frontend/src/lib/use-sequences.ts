import { useCallback, useEffect, useRef, useState } from "react"
import type { SequencesByLead, SequenceStep } from "@shared/types.ts"
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
   * Drop a deleted lead's steps from local state.
   *
   * No request: `sequence_steps.lead_id` is `on delete cascade`, so the rows are
   * already gone. This only stops a stale entry sitting in memory keyed to a lead
   * that no longer exists — and, more importantly, stops a queued content save
   * firing at one of its rows.
   */
  forget: (leadId: string) => void
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

  return { sequences, loading, error, editStep, setSteps, forget, flush }
}
