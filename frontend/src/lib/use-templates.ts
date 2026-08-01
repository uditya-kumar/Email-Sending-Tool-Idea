import { useCallback, useEffect, useRef, useState } from "react"
import type { EmailTemplate, SequenceStep } from "@shared/types.ts"
import {
  createTemplate,
  deleteTemplate,
  fetchTemplates,
  renameTemplate,
  replaceSteps,
  saveStep,
} from "./templates"

/**
 * Templates, backed by Supabase but edited locally.
 *
 * The split matters. Every keystroke updates local state immediately — a template
 * editor that awaited a round trip per character would be unusable — while writes
 * happen on two different schedules:
 *
 *  - **Structural** changes (add/delete/reorder a step) write straight away
 *    through `replaceSteps`, because Postgres assigns the new rows' ids and the
 *    editor needs them. Nothing can be sent from a step whose id is still local.
 *  - **Content** changes (subject, body) are debounced, then flushed on demand by
 *    `flush()` before a test send.
 *
 * `flush()` is what makes the test-send button honest: the server renders the row
 * it reads from the database, so an unflushed edit would be silently absent from
 * the email.
 */

/** Long enough to coalesce a burst of typing, short enough to feel saved. */
const SAVE_DEBOUNCE_MS = 800

export interface TemplatesStore {
  templates: EmailTemplate[]
  loading: boolean
  error: string | null
  /** Local-only edit of a step's content; persisted on a debounce. */
  editStep: (templateId: string, stepId: string, patch: Partial<SequenceStep>) => void
  /** Replaces a template's whole step list and adopts the ids Postgres assigns. */
  setSteps: (templateId: string, steps: SequenceStep[]) => Promise<SequenceStep[]>
  rename: (templateId: string, name: string) => void
  add: () => Promise<EmailTemplate | null>
  duplicate: (templateId: string) => Promise<EmailTemplate | null>
  remove: (templateId: string) => Promise<void>
  /** Write any pending debounced edits now. Await before sending. */
  flush: () => Promise<void>
}

/** A blank template's steps — one opening email, ready to be written. */
function blankSteps(): SequenceStep[] {
  return [
    {
      // Placeholder only. `replaceSteps` strips it and Postgres assigns a UUID,
      // which is the id that comes back and gets stored.
      id: "new",
      kind: "email",
      name: "Opening email",
      subject: "",
      bodyHtml: "",
    },
  ]
}

export function useTemplates(onError: (message: string) => void): TemplatesStore {
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * Pending content saves, keyed by step id so several edited steps each get
   * written once. Held in a ref rather than state: changing it must not re-render,
   * and `flush` needs to read the latest value rather than a closed-over snapshot.
   */
  const pending = useRef(new Map<string, { step: SequenceStep; position: number }>())
  const timer = useRef<number | null>(null)

  /**
   * `onError` behind a ref so the debounce callbacks don't take it as a
   * dependency — a caller passing an inline arrow (which is the normal thing to
   * do) would otherwise rebuild `flush` on every render and restart the timer.
   *
   * Assigned in an effect rather than during render: mutating a ref while
   * rendering is unsafe under concurrent rendering, where a render can be
   * discarded. Errors are only ever reported from an event handler or a timer, so
   * a value that lands after commit is soon enough.
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

    // Sequential rather than parallel: these are a handful of small updates, and
    // one failing shouldn't leave the others' outcome ambiguous.
    for (const { step, position } of queued) {
      try {
        await saveStep(step, position)
      } catch (cause) {
        report.current(cause instanceof Error ? cause.message : "Couldn't save the template.")
      }
    }
  }, [])

  useEffect(() => {
    let active = true

    fetchTemplates()
      .then((rows) => {
        if (!active) return
        setTemplates(rows)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : "Couldn't load templates.")
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  /*
   * Flush on unmount and on tab close. Without this, the last edit before
   * navigating away or closing the tab is lost — which for a debounced editor is
   * the single most likely edit to lose.
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
    (templateId: string, stepId: string, patch: Partial<SequenceStep>) => {
      setTemplates((prev) =>
        prev.map((t) => {
          if (t.id !== templateId) return t

          const steps = t.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s))
          const position = steps.findIndex((s) => s.id === stepId)
          const updated = steps[position]

          // Queue from the *merged* step, not the patch: `saveStep` writes whole
          // columns, so a patch alone would blank the fields it doesn't mention.
          if (updated) pending.current.set(stepId, { step: updated, position })

          return { ...t, steps }
        })
      )

      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [flush]
  )

  const setSteps = useCallback(
    async (templateId: string, steps: SequenceStep[]): Promise<SequenceStep[]> => {
      /*
       * Flush first. `replaceSteps` deletes every row and re-inserts, so a pending
       * content save aimed at one of the doomed ids would either fail or write to a
       * row that's about to vanish — either way the edit is lost.
       */
      await flush()

      try {
        const saved = await replaceSteps(templateId, steps)
        setTemplates((prev) =>
          prev.map((t) => (t.id === templateId ? { ...t, steps: saved } : t))
        )
        return saved
      } catch (cause) {
        report.current(cause instanceof Error ? cause.message : "Couldn't save the steps.")
        return steps
      }
    },
    [flush]
  )

  const rename = useCallback((templateId: string, name: string) => {
    setTemplates((prev) =>
      prev.map((t) => (t.id === templateId ? { ...t, name } : t))
    )

    // Not debounced with the step saves — a name is one column on one row, and
    // `templates` has no constraint a rapid rename could trip.
    void renameTemplate(templateId, name).catch((cause: unknown) => {
      report.current(cause instanceof Error ? cause.message : "Couldn't rename the template.")
    })
  }, [])

  const add = useCallback(async (): Promise<EmailTemplate | null> => {
    try {
      const created = await createTemplate("Untitled template", blankSteps())
      setTemplates((prev) => [...prev, created])
      return created
    } catch (cause) {
      report.current(cause instanceof Error ? cause.message : "Couldn't create the template.")
      return null
    }
  }, [])

  const duplicate = useCallback(
    async (templateId: string): Promise<EmailTemplate | null> => {
      await flush()

      const source = templates.find((t) => t.id === templateId)
      if (!source) return null

      try {
        const created = await createTemplate(`${source.name} (copy)`, source.steps)
        setTemplates((prev) => {
          const idx = prev.findIndex((t) => t.id === templateId)
          const next = [...prev]
          // Beside the original rather than appended — that's where the user
          // clicked Duplicate.
          next.splice(idx + 1, 0, created)
          return next
        })
        return created
      } catch (cause) {
        report.current(cause instanceof Error ? cause.message : "Couldn't duplicate the template.")
        return null
      }
    },
    [flush, templates]
  )

  const remove = useCallback(async (templateId: string) => {
    try {
      await deleteTemplate(templateId)
      setTemplates((prev) => prev.filter((t) => t.id !== templateId))
    } catch (cause) {
      report.current(cause instanceof Error ? cause.message : "Couldn't delete the template.")
    }
  }, [])

  return {
    templates,
    loading,
    error,
    editStep,
    setSteps,
    rename,
    add,
    duplicate,
    remove,
    flush,
  }
}
