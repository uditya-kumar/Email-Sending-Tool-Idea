import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Lets "Insert attribute" put its tag in the **subject** when that is where the
 * caret was.
 *
 * The button lives in the editor's toolbar, but the subject is a plain `<Input>`
 * belonging to the page — so nothing inside the editor can see both fields, and the
 * tag always went into the body. This hook is the piece that knows which one the
 * user was last in; the page hands its result down to `<EmailEditor>`.
 *
 * A hook rather than logic in one page because two pages have exactly this pair of
 * fields (compose Content and Templates), and a fix that only worked on one of them
 * would be the same bug with a smaller reproduction.
 *
 * ## Why the caret is remembered rather than read
 *
 * By the time the tag arrives, focus is inside the closing dialog: the toolbar button
 * takes focus on mousedown and the dialog takes it after that. So
 * `document.activeElement` at insert time says "neither field", and the input's live
 * selection is no longer the user's. `blur` is the last moment the caret is still
 * theirs — `selectionStart` survives the blur — which is why it is captured there.
 */
export interface SubjectInsert {
  /** Where an inserted tag should go. Pass straight to `<EmailEditor>`. */
  insertTarget: "body" | "subject"
  /** Hand to `<EmailEditor onBodyFocus>` so clicking into the body takes it back. */
  onBodyFocus: () => void
  /** Hand to `<EmailEditor onInsertOutside>`. */
  insertIntoSubject: (tag: string) => void
  /** Spread onto the subject `<Input>`. */
  subjectProps: {
    ref: React.RefObject<HTMLInputElement | null>
    onFocus: () => void
    onBlur: () => void
  }
}

export function useSubjectInsert({
  subject,
  onChange,
  /** Changing this returns the target to the body — see the effect below. */
  resetKey,
}: {
  subject: string
  onChange: (subject: string) => void
  resetKey: string
}): SubjectInsert {
  const [insertTarget, setInsertTarget] = useState<"body" | "subject">("body")
  const inputRef = useRef<HTMLInputElement>(null)
  const caret = useRef<number | null>(null)

  /*
   * `subject` behind a ref so `insertIntoSubject` doesn't change identity on every
   * keystroke — it is passed to a memo-free child either way, but a stable callback
   * keeps it from being a footgun if that ever changes.
   */
  const subjectRef = useRef(subject)
  subjectRef.current = subject

  // A different step's subject was never clicked into, so a "subject" left over from
  // the previous one would send the first insert to the wrong field.
  useEffect(() => {
    setInsertTarget("body")
    caret.current = null
  }, [resetKey])

  const insertIntoSubject = useCallback(
    (tag: string) => {
      const current = subjectRef.current
      // No remembered caret means the field was never really edited — append.
      const at = caret.current ?? current.length
      const inserted = `${tag} `

      onChange(`${current.slice(0, at)}${inserted}${current.slice(at)}`)

      // Left after the tag, so a second insert continues from there instead of
      // jumping back to where the first one started.
      const next = at + inserted.length
      caret.current = next

      /*
       * After paint: the value the caret is being measured against is the one React
       * has yet to render, and focus is still inside the dialog that is closing.
       * Restoring focus is the difference between "the tag is in the subject" and
       * "the user can carry on typing there".
       */
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(next, next)
      })
    },
    [onChange]
  )

  return {
    insertTarget,
    onBodyFocus: useCallback(() => setInsertTarget("body"), []),
    insertIntoSubject,
    subjectProps: {
      ref: inputRef,
      onFocus: useCallback(() => setInsertTarget("subject"), []),
      onBlur: useCallback(() => {
        caret.current = inputRef.current?.selectionStart ?? null
      }, []),
    },
  }
}
