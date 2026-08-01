import type { Tables } from "./database.types.ts"
import type {
  AllSettings,
  Lead,
  SenderAccount,
  SequenceStep,
  Weekday,
} from "./types.ts"

/**
 * snake_case database rows ↔ camelCase domain objects, in exactly one place.
 *
 * Every mapper is typed `(row: <generated row type>) => <domain type>`. That
 * signature is the whole point: a column rename in `schema.sql` becomes a
 * compile error *here* rather than an `undefined` in a component or, worse, in a
 * rendered email. Nothing else in either package may translate between the two
 * naming conventions.
 *
 * Two systematic differences are handled here and nowhere else:
 *  - Postgres nullable (`string | null`) vs TypeScript optional (`?: string`)
 *  - `int[]` weekday arrays vs the narrow `Weekday` union
 */

type LeadRow = Tables<"leads">
type SequenceStepRow = Tables<"sequence_steps">
type TemplateStepRow = Tables<"template_steps">
type SettingsRow = Tables<"settings">
type GmailAccountPublicRow = Tables<"gmail_accounts_public">

/**
 * `null` → `undefined`.
 *
 * The domain types use optional properties because that is what React forms and
 * `??` chains expect, while Postgres has no notion of "absent" — only null. With
 * `exactOptionalPropertyTypes` the two are genuinely different types, so the
 * conversion has to be explicit.
 */
function optional<T>(value: T | null): T | undefined {
  return value ?? undefined
}

export function leadFromRow(row: LeadRow): Lead {
  return {
    id: row.id,
    companyName: row.company_name,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    personalizationLine: row.personalization_line,
    sendTimeIST: row.send_time_ist,
    jobTitle: optional(row.job_title),
    website: optional(row.website),
    verification: row.verification,
    status: row.status,
    repliedAt: optional(row.replied_at),
  }
}

/**
 * The writable half of a lead. `id`, `status`, `replied_at` and `user_id` are
 * excluded deliberately: the first is assigned by Postgres and the rest belong
 * to the scheduler, so a form that could set them would be a bug.
 */
export function leadToRow(
  lead: Omit<Lead, "id" | "status" | "repliedAt">
): Omit<LeadRow, "id" | "user_id" | "status" | "replied_at" | "created_at" | "updated_at"> {
  return {
    company_name: lead.companyName,
    first_name: lead.firstName,
    last_name: lead.lastName,
    email: lead.email,
    personalization_line: lead.personalizationLine,
    send_time_ist: lead.sendTimeIST,
    job_title: lead.jobTitle ?? null,
    website: lead.website ?? null,
    verification: lead.verification,
  }
}

/**
 * A step row → the editor's step shape.
 *
 * Works for both `sequence_steps` and `template_steps`: the two tables have
 * identical columns apart from their parent key, and the editor genuinely does
 * not care which one a step came from.
 */
export function stepFromRow(row: SequenceStepRow | TemplateStepRow): SequenceStep {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    subject: optional(row.subject),
    bodyHtml: optional(row.body_html),
    waitDays: optional(row.wait_days),
  }
}

/**
 * A step → its columns, with `position` supplied by the caller from the array
 * index (order lives in the array on the client and in a column in the database).
 *
 * The `kind`-dependent nulling is what satisfies the `*_steps_shape` CHECK
 * constraint: a delay step must have `wait_days` and no email fields, an email
 * step the reverse. Getting this wrong is a 23514 at runtime, so it is encoded
 * once here rather than at each call site.
 */
export function stepToColumns(
  step: SequenceStep,
  position: number
): Pick<
  SequenceStepRow,
  "id" | "position" | "kind" | "name" | "subject" | "body_html" | "wait_days"
> {
  const isDelay = step.kind === "delay"

  return {
    id: step.id,
    position,
    kind: step.kind,
    name: step.name,
    subject: isDelay ? null : step.subject ?? "",
    body_html: isDelay ? null : step.bodyHtml ?? "",
    wait_days: isDelay ? step.waitDays ?? 0 : null,
  }
}

/**
 * `int[]` → `Weekday[]`.
 *
 * Postgres cannot express "0–6", so the column is a plain `int[]` and the
 * generated type is `number[]`. Filtering rather than casting means a stray 9
 * (hand-edited row, older schema) is dropped instead of reaching the weekday
 * gate and silently never matching.
 */
export function toWeekdays(values: number[]): Weekday[] {
  return values.filter((n): n is Weekday => Number.isInteger(n) && n >= 0 && n <= 6)
}

export function settingsFromRow(row: SettingsRow): AllSettings {
  return {
    trackOpens: row.track_opens,
    trackClicks: row.track_clicks,
    outreachDays: toWeekdays(row.outreach_days),
    followUpDays: toWeekdays(row.follow_up_days),
    jitterMinSeconds: row.jitter_min_seconds,
    jitterMaxSeconds: row.jitter_max_seconds,
    staleSendGraceHours: row.stale_send_grace_hours,
  }
}

/** Only the tracking/day fields — what `SettingsPage` actually edits. */
export function sequenceSettingsToRow(
  settings: Pick<AllSettings, "trackOpens" | "trackClicks" | "outreachDays" | "followUpDays">
): Pick<SettingsRow, "track_opens" | "track_clicks" | "outreach_days" | "follow_up_days"> {
  return {
    track_opens: settings.trackOpens,
    track_clicks: settings.trackClicks,
    outreach_days: settings.outreachDays,
    follow_up_days: settings.followUpDays,
  }
}

/**
 * The `gmail_accounts_public` **view** → `SenderAccount`.
 *
 * Every column of a view is nullable as far as Postgres is concerned, so the
 * generated type is all-optional even though the base table's are `not null`.
 * Rather than assert with `!`, a row missing an id or email is treated as
 * unusable and dropped by `sendersFromRows` — it cannot be sent from anyway.
 */
export function senderFromRow(row: GmailAccountPublicRow): SenderAccount | null {
  if (!row.id || !row.email) return null

  return {
    id: row.id,
    email: row.email,
    name: row.display_name ?? row.email,
    dailyLimit: row.daily_limit ?? 15,
    status: row.status ?? "active",
  }
}

export function sendersFromRows(rows: GmailAccountPublicRow[]): SenderAccount[] {
  return rows.map(senderFromRow).filter((s): s is SenderAccount => s !== null)
}
