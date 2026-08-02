import type { Tables } from "./database.types.ts"
import type {
  AllSettings,
  Lead,
  LeadEngagement,
  SenderAccount,
  SequenceSend,
  SequenceStep,
  StepAttachment,
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
type AttachmentRow = Tables<"attachments">
type LeadEngagementRow = Tables<"lead_engagement">
/**
 * Only the timing columns of a `sends` row.
 *
 * `Pick`, not the whole `Tables<"sends">`, because the caller selects exactly these
 * five columns — PostgREST types a projected `.select()` as a narrow object, so
 * asking for the full row here would reject the very query this mapper exists for.
 * Still derived from the generated type, so a rename in `schema.sql` still fails to
 * compile.
 */
type SendTimingRow = Pick<
  Tables<"sends">,
  "id" | "step_position" | "status" | "scheduled_at" | "sent_at"
>

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

export function attachmentFromRow(row: AttachmentRow): StepAttachment {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
  }
}

/**
 * A step row → the editor's step shape.
 *
 * Works for both `sequence_steps` and `template_steps`: the two tables have
 * identical columns apart from their parent key, and the editor genuinely does
 * not care which one a step came from.
 *
 * `attachments` are passed in rather than read from the row, because they live in
 * a join table that only some callers embed. Omitted → the property is absent,
 * which means "not loaded" and is deliberately different from `[]`; see
 * `SequenceStep.attachments`.
 */
export function stepFromRow(
  row: SequenceStepRow | TemplateStepRow,
  attachments?: AttachmentRow[] | undefined
): SequenceStep {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    subject: optional(row.subject),
    bodyHtml: optional(row.body_html),
    waitDays: optional(row.wait_days),
    ...(attachments ? { attachments: attachments.map(attachmentFromRow) } : {}),
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

/**
 * A `sends` row → the timing fields the compose sidebar needs.
 *
 * Narrow by design: see `SequenceSend` for why the rendered bodies and Gmail ids
 * are left behind rather than carried along "in case".
 */
export function sequenceSendFromRow(row: SendTimingRow): SequenceSend {
  return {
    id: row.id,
    stepPosition: row.step_position,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: optional(row.sent_at),
  }
}

/**
 * The `lead_engagement` **view** → counts, keyed by lead id.
 *
 * Returns a map rather than a list because every consumer wants one lead's
 * numbers, and the view has at most one row per lead.
 *
 * `?? 0` on every count, not `!`: each column of a view is nullable as far as
 * Postgres is concerned, so the generated types are all-optional even though
 * `count(*)` cannot actually be null. Zero is the honest reading either way —
 * "no events" — whereas asserting would be a lie about what the type says.
 * A row whose `lead_id` is null is skipped: there is no lead to key it under.
 */
export function engagementByLead(
  rows: LeadEngagementRow[]
): Record<string, LeadEngagement> {
  const byLead: Record<string, LeadEngagement> = {}

  for (const row of rows) {
    if (!row.lead_id) continue

    byLead[row.lead_id] = {
      opens: row.open_count ?? 0,
      proxyOpens: row.proxy_opens ?? 0,
      clicks: row.click_count ?? 0,
      distinctLinks: row.distinct_links ?? 0,
      replies: row.reply_count ?? 0,
      lastOpenAt: optional(row.last_open_at),
      lastClickAt: optional(row.last_click_at),
    }
  }

  return byLead
}
