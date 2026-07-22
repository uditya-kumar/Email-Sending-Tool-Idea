import { createClient } from "@supabase/supabase-js"

/**
 * Frontend Supabase client — uses the PUBLISHABLE key only.
 * All access is protected by RLS. Secret keys never live in the frontend
 * (those belong to the Express server). See CLAUDE.md.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
  | string
  | undefined

/**
 * `null` until the env vars are filled in. UI is currently built against
 * mock data, so the app runs without a configured Supabase project.
 */
export const supabase =
  url && publishableKey ? createClient(url, publishableKey) : null

export const isSupabaseConfigured = Boolean(url && publishableKey)
