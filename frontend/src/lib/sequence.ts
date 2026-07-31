import type { SequenceStep } from "./types"

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
    abTest: false,
  }
  return { steps: [...steps, delay, email], newStepId: email.id }
}

/** Insert a copy of an email step (preceded by a wait) right after the original. */
export function duplicateEmailStep(
  steps: SequenceStep[],
  id: string
): SequenceStep[] {
  const idx = steps.findIndex((s) => s.id === id)
  if (idx === -1) return steps
  const original = steps[idx]
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
  const start = idx > 0 && steps[idx - 1].kind === "delay" ? idx - 1 : idx
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
