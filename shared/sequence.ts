import type { EmailTemplate, SequenceStep } from "./types.ts"

/**
 * Pure step-list operations shared by the per-recipient compose flow and the
 * Templates page — both edit the same "email → wait → follow-up" shape.
 * `scope` prefixes generated ids (a lead id in compose, a template id in Templates)
 * so ids stay unique across sequences.
 *
 * Every id generated here is a **placeholder**, and deliberately not a UUID: the
 * shape is what tells the persistence layer which steps exist only on screen.
 * `sends.step_id` and `step_attachments.step_id` reference `sequence_steps(id)`, so
 * a real row needs a real UUID — the persistence layer replaces each placeholder
 * with one and returns the saved list. Nothing may be sent from a step whose id
 * still looks like one of these.
 */

/** The default wait between emails, in days — three, for a cold sequence. */
const DEFAULT_WAIT_DAYS = 3

/**
 * A fresh sequence for one recipient: opening → wait → follow-up → wait → follow-up.
 *
 * Each lead gets their own copy rather than a reference to a shared template,
 * because per-recipient personalization is the entire point of the compose flow.
 * The follow-ups start blank: an empty subject means "send as a reply in this
 * thread", which is the normal shape of a cold follow-up.
 */
export function newSequenceForLead(scope: string): SequenceStep[] {
  return [
    {
      id: `email-${scope}-0`,
      kind: "email",
      name: "Opening email",
      subject: "",
      bodyHtml: "",
    },
    { id: `delay-${scope}-1`, kind: "delay", name: "Wait", waitDays: DEFAULT_WAIT_DAYS },
    { id: `email-${scope}-2`, kind: "email", name: "Follow-up #1", subject: "", bodyHtml: "" },
    { id: `delay-${scope}-3`, kind: "delay", name: "Wait", waitDays: DEFAULT_WAIT_DAYS },
    { id: `email-${scope}-4`, kind: "email", name: "Follow-up #2", subject: "", bodyHtml: "" },
  ]
}

/** A blank template: one opening email, ready to be named and written. */
export function newTemplateSteps(scope: string): SequenceStep[] {
  return [
    {
      id: `email-${scope}-0`,
      kind: "email",
      name: "Opening email",
      subject: "",
      bodyHtml: "",
    },
  ]
}

/**
 * Copy a template's steps for one recipient, re-keying every id.
 *
 * Re-keying is not cosmetic: these ids are placeholders about to be replaced by
 * the database, and leaving the template's real `template_steps` UUIDs on them
 * would make an upsert believe the rows already exist in `sequence_steps`.
 */
export function stepsFromTemplate(
  template: EmailTemplate,
  scope: string
): SequenceStep[] {
  return template.steps.map((step, i) => ({
    ...step,
    id: `${step.kind}-${scope}-copy-${i}`,
  }))
}

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
