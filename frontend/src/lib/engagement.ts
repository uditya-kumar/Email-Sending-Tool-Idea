import { useCallback, useEffect, useRef, useState } from "react"
import { engagementByLead } from "@shared/mappers.ts"
import type { LeadEngagement } from "@shared/types.ts"
import { supabase } from "./supabase"

/**
 * Per-recipient open and click counts, read from the `lead_engagement` view.
 *
 * A view rather than columns on `leads`: `events` already holds one row per
 * open/click/reply, so the counts are derivable, and a counter column would be a
 * second source of truth that the tracking endpoints could fail to increment.
 * Aggregating in Postgres also beats shipping every event row here to be counted
 * in the browser. See `supabase/schema.sql`.
 *
 * Read directly under RLS with no server route in between, which is the same
 * arrangement as `leads` itself — `sends` and `events` are SELECT-only to the
 * browser, and the view runs as the caller (`security_invoker = true`), so their
 * own `read_own` policies scope it.
 */

/** No React in here, so both the effect and the poll can await it. */
export async function fetchEngagement(): Promise<Record<string, LeadEngagement>> {
  const { data, error } = await supabase.from("lead_engagement").select("*")

  if (error) throw new Error(error.message)

  return engagementByLead(data ?? [])
}

/**
 * How often to re-read the counts.
 *
 * Opens and clicks are written by the *server* — the tracking endpoints — so
 * nothing in this tab knows when they arrive, and without a poll the numbers
 * would only ever move on a reload. A minute is chosen against what this is for:
 * watching whether a just-sent email got read. Realtime would be the alternative,
 * but it means a websocket subscription and a publication on `events` for a
 * single user staring at one table.
 */
const POLL_MS = 60_000

export interface EngagementStore {
  /**
   * Counts keyed by lead id. **A missing key means the lead has no sends yet**,
   * not zero engagement — the view left-joins `events` onto `sends`, so a
   * recipient who has been emailed always has a row, even an all-zero one. The UI
   * leans on that difference to show "not sent" rather than a misleading "0".
   */
  engagement: Record<string, LeadEngagement>
  /** Only the first read. A failed poll leaves the previous numbers on screen. */
  loading: boolean
  /** Re-read now — after a launch, or when the tab comes back to the foreground. */
  refresh: () => Promise<void>
}

/**
 * `onError` is deliberately absent. This is a read of a derived, advisory number:
 * a failed poll costs the user a stale count, and a toast every minute on a flaky
 * connection would be worse than the staleness. Failures are logged and the last
 * good values stay on screen.
 */
export function useEngagement(): EngagementStore {
  const [engagement, setEngagement] = useState<Record<string, LeadEngagement>>({})
  const [loading, setLoading] = useState(true)

  /*
   * Guards a resolved read landing after unmount, and — under StrictMode's
   * double-mount — the first effect's result overwriting the second's. A ref
   * rather than a local, because the poll and `refresh` both need to see it.
   */
  const active = useRef(true)

  /*
   * A promise chain rather than `async`/`await`, so every `setState` sits inside a
   * callback. The effect below calls this directly, and a state update reachable
   * *synchronously* from an effect body is a cascading render — which
   * `react-hooks/set-state-in-effect` rejects even when, as here, the update can
   * only happen after a network round trip.
   */
  const load = useCallback(
    () =>
      fetchEngagement()
        .then((rows) => {
          if (active.current) setEngagement(rows)
        })
        .catch((cause: unknown) => {
          // Logged, not surfaced: see the note on the hook.
          console.warn("Couldn't read engagement counts", cause)
        })
        .finally(() => {
          if (active.current) setLoading(false)
        }),
    []
  )

  useEffect(() => {
    active.current = true
    void load()

    /*
     * Only poll a visible tab. A background tab's timers are throttled anyway,
     * and re-reading for a table nobody is looking at is pure waste — so the
     * `visibilitychange` listener also fires an immediate read on return, which
     * is when the numbers most need to be current.
     */
    const tick = () => {
      if (document.visibilityState === "visible") void load()
    }

    const timer = window.setInterval(tick, POLL_MS)
    document.addEventListener("visibilitychange", tick)

    return () => {
      active.current = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [load])

  return { engagement, loading, refresh: load }
}
