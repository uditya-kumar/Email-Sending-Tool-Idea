import type { SequenceStep } from "./types.ts"

/**
 * Pure step-list operations shared by the per-recipient compose flow and the
 * Templates page — both edit the same "email → wait → follow-up" shape.
 * `scope` prefixes generated ids (a lead id in compose, a template id in Templates)
 * so ids stay unique across sequences.
 */

/** Append a wait + a new follow-up email. Returns the list and the new email's id. */
export function appendFollowUp(
  steps: SequenceStep[],
  scope: string
): { steps: SequenceStep[]; newStepId: string } {
  const followCount = steps.filter((s) =>
    s.name.toLowerCase().includes("follow")
  ).length
  const stamp = `${scope}-${steps.length}-${followCount}`
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
  }
  return { steps: [...steps, delay, email], newStepId: email.id }
}

/** Insert a copy of an email step (preceded by a wait) right after the original. */
export function duplicateEmailStep(
  steps: SequenceStep[],
  id: string
): SequenceStep[] {
  const idx = steps.findIndex((s) => s.id === id)
  const original = steps[idx]
  if (!original) return steps
  const copy: SequenceStep = {
    ...original,
    id: `email-copy-${steps.length}-${id}`,
    name: `${original.name} (copy)`,
  }
  const delay: SequenceStep = {
    id: `delay-copy-${steps.length}-${id}`,
    kind: "delay",
    name: "Wait",
    waitDays: 3,
  }
  const next = [...steps]
  next.splice(idx + 1, 0, delay, copy)
  return next
}

/** Remove an email step along with the wait immediately preceding it, if any. */
export function removeEmailStep(
  steps: SequenceStep[],
  id: string
): SequenceStep[] {
  const idx = steps.findIndex((s) => s.id === id)
  if (idx === -1) return steps
  const start = steps[idx - 1]?.kind === "delay" ? idx - 1 : idx
  return steps.filter((_, i) => i < start || i > idx)
}

/** Set the wait length on a delay step. */
export function setDelayDays(
  steps: SequenceStep[],
  id: string,
  waitDays: number
): SequenceStep[] {
  return steps.map((s) => (s.id === id ? { ...s, waitDays } : s))
}

/** Apply a partial patch to one step. */
export function patchStep(
  steps: SequenceStep[],
  id: string,
  patch: Partial<SequenceStep>
): SequenceStep[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s))
}

/** Human summary of a sequence, e.g. "3 emails · 6 days". */
export function describeSequence(steps: SequenceStep[]): string {
  const emails = steps.filter((s) => s.kind === "email").length
  const days = steps
    .filter((s) => s.kind === "delay")
    .reduce((sum, s) => sum + (s.waitDays ?? 0), 0)
  const emailLabel = `${emails} email${emails === 1 ? "" : "s"}`
  return days > 0 ? `${emailLabel} · ${days} days` : emailLabel
}

/**
 * The email step that follows `position`, and how many days of waiting sit
 * between the two. `null` when the sequence is over.
 *
 * This is the whole of the follow-up scheduling rule, kept out of the scheduler
 * so it can be reasoned about (and unit-tested) without a database: walk
 * forward from the step that just went out, accumulate every `delay`, stop at
 * the first `email`.
 */
export function nextEmailAfter<T extends { position: number; kind: SequenceStep["kind"]; waitDays?: number | undefined }>(
  steps: readonly T[],
  position: number
): { step: T; waitDays: number } | null {
  const ordered = [...steps].sort((a, b) => a.position - b.position)
  let waitDays = 0

  for (const step of ordered) {
    if (step.position <= position) continue
    if (step.kind === "delay") {
      waitDays += step.waitDays ?? 0
      continue
    }
    return { step, waitDays }
  }

  return null
}

/** The first email step in a sequence, which is what launching a lead sends. */
export function firstEmailStep<T extends { position: number; kind: SequenceStep["kind"] }>(
  steps: readonly T[]
): T | null {
  return (
    [...steps]
      .sort((a, b) => a.position - b.position)
      .find((s) => s.kind === "email") ?? null
  )
}
