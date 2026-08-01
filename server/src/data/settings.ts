import { db, unwrap, type SettingsRow } from "../db.ts"
import { settingsFromRow } from "../../../shared/mappers.ts"
import { DEFAULT_SETTINGS } from "../../../shared/settings.ts"
import type { AllSettings } from "../../../shared/types.ts"

/**
 * The single `settings` row, read through the same mapper the frontend uses.
 *
 * Every value the scheduler branches on — which weekdays are eligible, how long
 * to jitter, how late a send may still go out — comes from here, so the tick has
 * no constants of its own to drift out of sync with the Settings page.
 */

// Re-exported so existing server imports keep working; the constant itself moved
// to `shared/` once the frontend needed the same fallback.
export { DEFAULT_SETTINGS }

export async function loadSettings(userId: string): Promise<AllSettings> {
  const row: SettingsRow | null = await unwrap(
    "load settings",
    db.from("settings").select("*").eq("user_id", userId).maybeSingle()
  )

  return row ? settingsFromRow(row) : DEFAULT_SETTINGS
}
