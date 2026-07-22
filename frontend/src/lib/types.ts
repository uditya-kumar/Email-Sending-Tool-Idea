/**
 * Domain types for the cold-email outreach tool.
 * These mirror the planned Supabase tables (see CLAUDE.md).
 */

export type VerificationStatus = "verified" | "not_verified" | "invalid"

/** A single recipient / lead row in the Audience table. */
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

export type WizardTab = "audience" | "content" | "preview" | "settings"
