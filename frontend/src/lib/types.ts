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
  contactFullName: string
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

/** The merge attributes a template can reference. */
export type MergeAttributeKey =
  | "first_name"
  | "last_name"
  | "full_name"
  | "company"
  | "email"
  | "job_title"
  | "personalization"

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
  abTest?: boolean
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

export type SenderStatus = "active" | "needs_protection" | "disconnected"

/** A connected Gmail sender account. */
export interface SenderAccount {
  id: string
  email: string
  name: string
  status: SenderStatus
  provider: string
  allocatedRecipients: number
  sentToday: number
  dailyLimit: number
  signatureHtml?: string
}

/** Day of week, 0 = Monday … 6 = Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Per-sequence tracking + sending settings. */
export interface SequenceSettings {
  trackOpens: boolean
  trackClicks: boolean
  bccEnabled: boolean
  bccAddress: string
  /** Days of the week the sequence is allowed to send. */
  sendingDays: Weekday[]
  /** Sending window in IST ("HH:mm"). */
  sendWindowStart: string
  sendWindowEnd: string
  /** Optionally schedule the launch for a future date (YYYY-MM-DD). */
  startOnSpecificDay: boolean
  startDate: string
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
