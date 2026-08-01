import { useCallback, useEffect, useState } from "react"
import { sendersFromRows } from "@shared/mappers.ts"
import type { SenderAccount } from "@shared/types.ts"
import { supabase } from "./supabase"

/**
 * The connected Gmail account(s).
 *
 * Read from the `gmail_accounts_public` **view**, never the `gmail_accounts`
 * table: that table holds `refresh_token_enc` and has no RLS policy at all, so it
 * is simply unreachable with the publishable key. The view exposes the safe
 * subset and filters on `auth.uid()` itself (see schema.sql).
 */

/** The query, with no React in it — so both the effect and `refresh` can await it. */
async function loadSenders(): Promise<SenderAccount[]> {
  const { data, error } = await supabase
    .from("gmail_accounts_public")
    .select("id, email, display_name, daily_limit, status, created_at")
    .order("created_at", { ascending: true })

  if (error) throw new Error(error.message)

  // `sendersFromRows` drops rows with no id or email — every column of a view is
  // nullable to Postgres, and such a row could not be sent from anyway.
  return sendersFromRows(data ?? [])
}

export function useSenders(): {
  senders: SenderAccount[]
  loading: boolean
  error: string | null
  /** Re-read after a connect or disconnect. */
  refresh: () => Promise<void>
} {
  const [senders, setSenders] = useState<SenderAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSenders(await loadSenders())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load accounts.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    /*
     * Guards against a resolved query landing after unmount, and — under
     * StrictMode's double-mount — against the first effect's result overwriting
     * the second's.
     */
    let active = true

    loadSenders()
      .then((rows) => {
        if (!active) return
        setSenders(rows)
        setError(null)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : "Couldn't load accounts.")
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  return { senders, loading, error, refresh }
}

/**
 * Change a sender's daily cap.
 *
 * Goes through the `set_daily_limit` SECURITY DEFINER function rather than an
 * UPDATE: the browser has no write privilege on `gmail_accounts`, and this is the
 * one field of it the UI is allowed to change.
 */
export async function setDailyLimit(
  accountId: string,
  limit: number
): Promise<string | null> {
  const { error } = await supabase.rpc("set_daily_limit", {
    p_account_id: accountId,
    p_limit: limit,
  })

  return error ? error.message : null
}
