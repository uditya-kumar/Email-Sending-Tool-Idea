import { useCallback, useEffect, useRef, useState } from "react"
import { newTemplateSteps } from "@shared/sequence.ts"
import type { EmailTemplate, SequenceStep, StepAttachment } from "@shared/types.ts"
import { attachFileToStep, removeAttachment } from "./attachments"
import { isPersistedStepId } from "./sequences"
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
  /**
   * Upload a file and attach it to one **persisted** template step.
   *
   * The point of attaching here rather than per recipient: a resume uploaded to the
   * "AI role" template comes along every time that template is applied, so it is
   * picked once instead of once per email. Rejects with a message meant to be shown.
   */
  attach: (templateId: string, stepId: string, file: File) => Promise<void>
  /**
   * Detach a file from a template step.
   *
   * Only deletes the stored file if nothing else references it — leads the template
   * has already been applied to share the same `attachments` row, including ones with
   * queued sends. `removeAttachment` counts the references.
   */
  detach: (templateId: string, stepId: string, attachment: StepAttachment) => Promise<void>
  /** Write any pending debounced edits now. Await before sending. */
  flush: () => Promise<void>
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
       * Flush first. `replaceSteps` deletes the rows that are gone, so a pending
       * content save aimed at one of them would either fail or write to a row about to
       * vanish — and for a surviving step, a write landing *after* the upsert would be
       * lost to it.
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
      /*
       * The placeholder ids `newTemplateSteps` generates are replaced by
       * `replaceSteps` with real UUIDs; those are what come back and get stored.
       */
      const created = await createTemplate("Untitled template", newTemplateSteps("new"))
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
        /*
         * `source.steps` still carry the original's real UUIDs. `replaceSteps` re-keys
         * them — it only reuses an id already owned by the template being written —
         * which is what stops this *moving* the original's rows into the copy. Their
         * attachments are re-linked to the new rows, so the copy shares the same files.
         */
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

  /**
   * Rewrite one step's attachment list in place.
   *
   * A functional update rather than a read of `templates`, so an upload that resolves
   * after an unrelated edit doesn't reinstate the older list.
   */
  const putAttachments = useCallback(
    (
      templateId: string,
      stepId: string,
      next: (current: StepAttachment[]) => StepAttachment[]
    ) => {
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === templateId
            ? {
                ...t,
                steps: t.steps.map((step) =>
                  step.id === stepId
                    ? { ...step, attachments: next(step.attachments ?? []) }
                    : step
                ),
              }
            : t
        )
      )
    },
    []
  )

  const attach = useCallback(
    async (templateId: string, stepId: string, file: File) => {
      /*
       * `template_step_attachments.template_step_id` is a foreign key, so a
       * placeholder id would fail with a 23503 the user can't act on. Templates are
       * persisted on creation, so this is a guard rather than a path.
       */
      if (!isPersistedStepId(stepId)) {
        throw new Error("Save the template before attaching a file to it.")
      }

      /*
       * The step's current total, because the size limit is per message — see
       * `MAX_ATTACHMENT_BYTES`. Read from the live list rather than passed in by the
       * component, so the check can't be bypassed by a stale prop.
       */
      const attached =
        templates
          .find((t) => t.id === templateId)
          ?.steps.find((step) => step.id === stepId)?.attachments ?? []
      const attachedBytes = attached.reduce((sum, f) => sum + f.sizeBytes, 0)

      // No optimistic insert: a file that appears and then vanishes reads as data
      // loss rather than as a rejected upload.
      const saved = await attachFileToStep(stepId, file, attachedBytes, "template")

      putAttachments(templateId, stepId, (current) =>
        [...current, saved].sort((a, b) => a.filename.localeCompare(b.filename))
      )
    },
    [putAttachments, templates]
  )

  const detach = useCallback(
    async (templateId: string, stepId: string, attachment: StepAttachment) => {
      await removeAttachment(attachment, stepId, "template")
      putAttachments(templateId, stepId, (current) =>
        current.filter((f) => f.id !== attachment.id)
      )
    },
    [putAttachments]
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
    attach,
    detach,
    flush,
  }
}
