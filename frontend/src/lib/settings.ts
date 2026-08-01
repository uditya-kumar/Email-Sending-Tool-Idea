import { useEffect, useState } from "react"
import { settingsFromRow, sequenceSettingsToRow } from "@shared/mappers.ts"
import { DEFAULT_SETTINGS } from "@shared/settings.ts"
import type { AllSettings, SequenceSettings } from "@shared/types.ts"
import { currentUserId, supabase } from "./supabase"

/**
 * The single `settings` row.
 *
 * One row per user, primary key `user_id`, so there is nothing to create or
 * delete from the UI — only read and update. RLS filters reads on `auth.uid()`,
 * which is why `fetchSettings` needs no filter of its own; the update does need
 * one, for a reason that has nothing to do with security (see below).
 *
 * The row can legitimately be missing (auth user created, `schema.sql`'s seed
 * insert not yet run), so a read falls back to `DEFAULT_SETTINGS` rather than
 * failing. That's the same fallback the server's tick uses, from the same
 * constant.
 */

/** Read the row, or the column defaults if it doesn't exist yet. */
export async function fetchSettings(): Promise<AllSettings> {
  const { data, error } = await supabase.from("settings").select("*").maybeSingle()

  if (error) throw new Error(error.message)

  return data ? settingsFromRow(data) : DEFAULT_SETTINGS
}

/**
 * Save the four fields the Settings page owns.
 *
 * Deliberately **not** an upsert of the whole object. `jitter_*` and
 * `stale_send_grace_hours` are the scheduler's, and writing them back from a page
 * that doesn't edit them would silently reset a hand-tuned value every time the
 * user toggled a weekday. `sequenceSettingsToRow` projects exactly the four
 * columns; an UPDATE leaves the rest alone.
 */
export async function saveSequenceSettings(
  settings: SequenceSettings
): Promise<void> {
  const { data, error } = await supabase
    .from("settings")
    .update(sequenceSettingsToRow(settings))
    /*
     * Explicit filter, even though RLS would restrict this to the same one row.
     * PostgREST rejects a filter-less UPDATE outright with `21000: UPDATE requires
     * a WHERE clause` — a guard against a forgotten `.eq()` rewriting a whole
     * table — and it applies before RLS is consulted.
     */
    .eq("user_id", await currentUserId())
    /*
     * `select()` so the outcome is observable. Without it an UPDATE that matched
     * no row — the un-seeded case above — succeeds with no error, and the UI would
     * report "Settings saved" over a database that changed nothing.
     */
    .select("user_id")

  if (error) throw new Error(error.message)

  if (!data || data.length === 0) {
    throw new Error(
      "No settings row to update. Run the seed insert at the bottom of supabase/schema.sql."
    )
  }
}

export interface SettingsStore {
  settings: AllSettings
  loading: boolean
  /** A failed *read*. A failed save is reported to the caller of `save` instead. */
  error: string | null
  /** Local-only edit. Nothing is written until `save`. */
  patch: (patch: Partial<SequenceSettings>) => void
  /** True when the local copy differs from what was last read or saved. */
  dirty: boolean
  /** Persist. Resolves to an error message, or null on success. */
  save: () => Promise<string | null>
}

/**
 * Settings, edited locally and saved on the button.
 *
 * No debounced autosave, unlike `useTemplates`. The page has an explicit "Save
 * settings" button, and these values change the behaviour of every future send —
 * a half-typed weekday set silently taking effect is worse here than a save the
 * user has to click. `dirty` exists so that button can say whether there is
 * anything to save.
 */
export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState<AllSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    // Guards a resolved read landing after unmount, and StrictMode's double-mount.
    let active = true

    fetchSettings()
      .then((row) => {
        if (!active) return
        setSettings(row)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : "Couldn't load settings.")
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  function patch(next: Partial<SequenceSettings>) {
    setSettings((prev) => ({ ...prev, ...next }))
    setDirty(true)
  }

  async function save(): Promise<string | null> {
    try {
      await saveSequenceSettings(settings)
      setDirty(false)
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Couldn't save settings."
    }
  }

  return { settings, loading, error, patch, dirty, save }
}
