import { db, unwrap, type SettingsRow } from "../db.ts"
import { settingsFromRow } from "../../../shared/mappers.ts"
import type { AllSettings } from "../../../shared/types.ts"

/**
 * The single `settings` row, read through the same mapper the frontend uses.
 *
 * Every value the scheduler branches on — which weekdays are eligible, how long
 * to jitter, how late a send may still go out — comes from here, so the tick has
 * no constants of its own to drift out of sync with the Settings page.
 */

/**
 * Used when the row is missing, which happens exactly once: between creating the
 * auth user and running the seed insert at the bottom of `schema.sql`. Mirroring
 * the column defaults means a first tick in that window behaves identically to
 * one after the seed rather than crashing.
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

export async function loadSettings(userId: string): Promise<AllSettings> {
  const row: SettingsRow | null = await unwrap(
    "load settings",
    db.from("settings").select("*").eq("user_id", userId).maybeSingle()
  )

  return row ? settingsFromRow(row) : DEFAULT_SETTINGS
}
