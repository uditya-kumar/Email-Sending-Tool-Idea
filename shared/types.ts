/**
 * Domain types for the cold-email outreach tool — the vocabulary the UI thinks
 * in (camelCase, optional fields) as opposed to the database rows in
 * `database.types.ts` (snake_case, nullable). `mappers.ts` is the only bridge
 * between the two.
 *
 * Every status union is **derived from the generated DB enums** rather than
 * hand-written, so widening a Postgres enum immediately surfaces as a compile
 * error in the components that switch on it instead of a runtime `undefined`.
 */

import type { Enums } from "./database.types.ts"

export type VerificationStatus = Enums<"verification_status">

/**
 * Where a recipient's own sequence stands.
 *
 * `draft` → `scheduled` → `sending` → `sent`, with `replied` / `failed` /
 * `cancelled` as terminal detours. The scheduler owns every transition after
 * `scheduled`.
 */
export type LeadStatus = Enums<"lead_status">

/** A single recipient / lead row in the Database table. */
export interface Lead {
  id: string
  companyName: string
  /**
   * Stored as two fields rather than one full name: a cold email almost always
   * greets on the first name alone, so it has to be addressable on its own.
   */
  firstName: string
  lastName: string
  email: string
  /** One-line personalization used via the {{personalization}} tag. */
  personalizationLine: string
  /** Send time expressed in IST as "HH:mm" (24h). */
  sendTimeIST: string
  jobTitle?: string | undefined
  website?: string | undefined
  verification: VerificationStatus
  /** Status of this recipient's own sequence (each lead is launched separately). */
  status: LeadStatus
  /**
   * When a reply was detected on this lead's thread. Non-null is what stops
   * every pending follow-up, so it is the authoritative "stop" signal rather
   * than `status === "replied"`.
   */
  repliedAt?: string | undefined
}

/**
 * The merge attributes a template can reference — one per data column of the
 * Database table (see MERGE_ATTRIBUTES).
 */
export type MergeAttributeKey =
  | "email"
  | "first_name"
  | "last_name"
  | "company"
  | "personalization"
  | "job_title"
  | "website"
  | "send_time"

export interface MergeAttribute {
  key: MergeAttributeKey
  label: string
}

export type SequenceStepKind = Enums<"step_kind">

/**
 * A file stored in the `attachments` bucket and linked to an email step.
 *
 * `storagePath` is deliberately included even though the UI never displays it: it
 * is what a remove has to delete from Storage, and the row alone would leave the
 * object orphaned in the bucket.
 */
export interface StepAttachment {
  id: string
  /** The name the recipient sees. */
  filename: string
  mimeType: string
  sizeBytes: number
  /** `attachments/<user_id>/<uuid>.<ext>` — the object's key in the bucket. */
  storagePath: string
}

/** A step in the follow-up sequence: either an email or a wait. */
export interface SequenceStep {
  id: string
  kind: SequenceStepKind
  /** Display name, e.g. "Opening email", "Follow-up #1". */
  name: string
  /** Email fields (present when kind === "email"). */
  subject?: string | undefined
  /** HTML body produced by the Tiptap editor. */
  bodyHtml?: string | undefined
  /** Delay fields (present when kind === "delay"). */
  waitDays?: number | undefined
  /**
   * Files attached to this email, or undefined when they haven't been read.
   *
   * Undefined rather than `[]` for "not loaded" is load-bearing: `stepToColumns`
   * writes whole columns, and the whole-list save paths reconstruct steps from
   * what's in memory. An empty array would be indistinguishable from "this step
   * genuinely has no attachments" and a save could then drop the links.
   */
  attachments?: StepAttachment[] | undefined
}

/**
 * A reusable template: the whole sequence blueprint — opening email, waits, and
 * follow-ups. Applying one to a recipient replaces their entire compose setup.
 */
export interface EmailTemplate {
  id: string
  name: string
  /** Same step list a recipient's sequence uses, so it drops straight in. */
  steps: SequenceStep[]
}

/**
 * The owner's own account — who is logged in. Deliberately separate from
 * SenderAccount: disconnecting the Gmail you send *through* shouldn't erase who
 * you are, so the profile survives an empty sender list.
 */
export interface UserProfile {
  name: string
  email: string
}

/** Whether a connected Gmail account can still send. */
export type AccountStatus = Enums<"account_status">

/**
 * A connected Gmail sender account. Deliberately minimal: the address, the
 * daily send cap and whether it still has valid credentials are the only things
 * this tool needs to know about it.
 *
 * Mirrors the `gmail_accounts_public` view — the encrypted tokens on the base
 * table are never exposed to the browser.
 */
export interface SenderAccount {
  id: string
  email: string
  name: string
  /** Daily send cap — the deliverability guard (see CLAUDE.md). */
  dailyLimit: number
  /**
   * Percentage of `dailyLimit` reserved for follow-ups on a capped day — a
   * ceiling either class can borrow past, not a quota. See `shared/send-budget.ts`.
   *
   * A percentage rather than a count so it survives a change to `dailyLimit`.
   */
  followUpSharePct: number
  /** `needs_reauth` is rendered as a Reconnect prompt rather than a silent failure. */
  status: AccountStatus
}

/** Day of week, 0 = Monday … 6 = Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Per-sequence tracking + sending settings. */
export interface SequenceSettings {
  trackOpens: boolean
  trackClicks: boolean
  /**
   * Days of the week a first-touch email to a new lead may go out. Kept separate
   * from follow-ups because cold opens land best early in the week, while a
   * follow-up on an existing thread is fine any working day.
   *
   * There's no hour window — each lead's own IST send time decides when their
   * email goes out; these only decide which days are eligible.
   */
  outreachDays: Weekday[]
  /** Days of the week a follow-up in an existing thread may go out. */
  followUpDays: Weekday[]
}

/**
 * Deliverability knobs the scheduler reads but the UI does not currently edit.
 * Split from `SequenceSettings` so the settings page keeps its small surface
 * while the server still gets everything from one row.
 */
export interface SchedulerSettings {
  /** Random gap between two consecutive sends inside one tick. */
  jitterMinSeconds: number
  jitterMaxSeconds: number
  /**
   * How late a send may be and still go out. Past this it is pushed to the next
   * allowed day rather than delivering a three-day-old email at 2am.
   */
  staleSendGraceHours: number
}

/** Every field of the single `settings` row. */
export type AllSettings = SequenceSettings & SchedulerSettings

/**
 * Every recipient owns their own sequence, keyed by lead id — that's what makes
 * per-recipient personalization possible (see the compose flow).
 */
export type SequencesByLead = Record<string, SequenceStep[]>

/** Top-level pages of the app. */
export type AppView = "database" | "templates" | "settings" | "compose"

/** Steps inside the per-recipient compose flow. */
export type ComposeStep = "content" | "preview"

/** Engagement recorded against one sent email. */
export type EventType = Enums<"event_type">

/** Lifecycle of one row in the scheduler's queue. */
export type SendStatus = Enums<"send_status">

/**
 * One queued or delivered email, as the compose sidebar needs it.
 *
 * A deliberately narrow projection of `sends`: the browser has SELECT on that
 * table, but the sidebar only needs to answer "has this step gone out, and when",
 * so the rendered bodies, Gmail ids and error text stay out. Keyed to a step by
 * `stepPosition` rather than `stepId`, because `sends.step_id` is
 * `on delete set null` — a step deleted and re-added loses the link while the
 * position survives.
 */
export interface SequenceSend {
  id: string
  /** Index of the step in the sequence — `sequence_steps.position`. */
  stepPosition: number
  status: SendStatus
  /** When the scheduler intends to send, or did. Always present. */
  scheduledAt: string
  /** When it actually went out; only set once `status` is `sent`. */
  sentAt?: string | undefined
}

/**
 * Why an email in a sequence will never go out.
 *
 * Machine-readable alongside `stopped`'s prose `reason`, because the label the
 * user reads is not the sentence: "Won't send" alone leaves them looking for the
 * cause, and matching on the prose to find it would make a reworded sentence a
 * silent UI change.
 *
 * `replied` is the one worth telling apart — it is the outcome the tool exists to
 * produce, whereas the other two are housekeeping.
 */
export type StoppedCause = "replied" | "cancelled" | "skipped"

/**
 * When one email in a sequence is due, and how much to trust that.
 *
 * The `kind` is the hedge. Only `sent` is history; `scheduled` is a real queued
 * row, and `projected` is arithmetic that can still move — follow-ups are queued
 * one at a time, so a step two places out has no row yet and its time depends on
 * when the email before it actually goes out. Collapsing the two would present a
 * guess with the same confidence as a fact.
 *
 * See `projectSequenceSchedule`, which is the only thing that builds these.
 */
export type StepTiming =
  /** Delivered. `at` is `sent_at` — what happened, not what was planned. */
  | { kind: "sent"; at: string }
  /** Claimed by the scheduler and in flight right now. */
  | { kind: "sending" }
  /** A real `pending` row: `at` is the `scheduled_at` the tick will fire on. */
  | { kind: "scheduled"; at: string }
  /** No row yet — `at` is computed from the step before it and may move. */
  | { kind: "projected"; at: string }
  /** The sequence ended here: a reply, or a cancelled step. */
  | { kind: "stopped"; cause: StoppedCause; reason: string }
  /** Can't be scheduled at all — an earlier step failed, or the settings forbid it. */
  | { kind: "blocked"; reason: string }

/**
 * How much one recipient has engaged, counted across every email in their
 * sequence — the `lead_engagement` view.
 *
 * Counts rather than booleans, because a single open proves almost nothing:
 * Apple Mail Privacy Protection and Gmail's image proxy fetch the pixel before
 * anyone has looked at the message. A *second* open minutes later is a person
 * coming back to it, and that distinction is the whole reason this exists.
 *
 * Per lead rather than per email: a sequence is several messages in one thread,
 * and the question the Database table answers is "did this person engage".
 */
export interface LeadEngagement {
  /**
   * How many times this recipient **read the thread** — not how many pixel
   * fetches arrived.
   *
   * The two differ because opening a thread fetches the pixel of every message in
   * it, so a lead three steps into their sequence produces three fetches per
   * read. `lead_engagement` groups a lead's opens into reads by elapsed time
   * (fetches ≤ 10s apart are one read), which is what keeps one read showing as
   * `1` however long the thread has grown.
   *
   * Anything further apart than that window still counts separately, including a
   * re-open fifteen seconds later: deliberately re-opening a message is the
   * clearest evidence of a human there is, and collapsing it would discard the
   * signal this number exists for.
   */
  opens: number
  /**
   * How many of those reads involved a provider's image proxy.
   *
   * **Not a noise count to subtract.** Gmail serves every image through
   * GoogleImageProxy, including the fetch caused by a human opening the message,
   * so for a Gmail recipient this equals `opens` and every one of them is real.
   * It exists only to hedge the single-open case, where a lone open shortly after
   * delivery may be a prefetch rather than a read.
   */
  proxyOpens: number
  clicks: number
  /**
   * How many *different* links were clicked. Three clicks on one link is a
   * weaker signal than one click on three, so the two aren't interchangeable.
   */
  distinctLinks: number
  /** Replies detected on the thread — the strongest signal there is. */
  replies: number
  lastOpenAt?: string | undefined
  lastClickAt?: string | undefined
}
