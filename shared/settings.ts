import type { AllSettings } from "./types.ts"

/**
 * The `settings` column defaults, mirrored in TypeScript.
 *
 * Shared rather than duplicated per package because both sides need it for the
 * same reason: the row can be legitimately absent. On the server that window is
 * between creating the auth user and running the seed insert at the bottom of
 * `schema.sql`; in the browser it is the moment before the first fetch resolves.
 * Two copies of these numbers would drift, and the failure mode is silent — a
 * scheduler jittering 45–240s while the UI claims something else.
 *
 * Keep in step with `schema.sql`. This is the one place duplicating the database's
 * own defaults, which is unavoidable: Postgres won't tell us what they are without
 * a round trip, and the fallback exists precisely for when there's no row to read.
 */
export const DEFAULT_SETTINGS: AllSettings = {
  trackOpens: false,
  trackClicks: false,
  outreachDays: [0, 1, 2, 3],
  followUpDays: [0, 1, 2, 3, 4],
  jitterMinSeconds: 45,
  jitterMaxSeconds: 240,
  staleSendGraceHours: 6,
}
