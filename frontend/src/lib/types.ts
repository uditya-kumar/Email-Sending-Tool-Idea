/**
 * Domain types for the cold-email outreach tool.
 * These mirror the planned Supabase tables (see CLAUDE.md).
 */

export type VerificationStatus = "verified" | "not_verified" | "invalid"

/** Where a recipient's own sequence stands. */
export type LeadStatus = "draft" | "scheduled" | "sent"

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
  jobTitle?: string
  website?: string
  verification: VerificationStatus
  /** Status of this recipient's own sequence (each lead is launched separately). */
  status: LeadStatus
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

export type SequenceStepKind = "email" | "delay"

/** A step in the follow-up sequence: either an email or a wait. */
export interface SequenceStep {
  id: string
  kind: SequenceStepKind
  /** Display name, e.g. "Opening email", "Follow-up #1". */
  name: string
  /** Email fields (present when kind === "email"). */
  subject?: string
  /** HTML body produced by the Tiptap editor. */
  bodyHtml?: string
  /** Delay fields (present when kind === "delay"). */
  waitDays?: number
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

/**
 * A connected Gmail sender account. Deliberately minimal: the address and the
 * daily send cap are the only things this tool needs to know about it.
 */
export interface SenderAccount {
  id: string
  email: string
  name: string
  /** Daily send cap — the deliverability guard (see CLAUDE.md). */
  dailyLimit: number
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
 * Every recipient owns their own sequence, keyed by lead id — that's what makes
 * per-recipient personalization possible (see the compose flow).
 */
export type SequencesByLead = Record<string, SequenceStep[]>

/** Top-level pages of the app. */
export type AppView = "database" | "templates" | "settings" | "compose"

/** Steps inside the per-recipient compose flow. */
export type ComposeStep = "content" | "preview"
