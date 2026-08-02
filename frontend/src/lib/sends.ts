import { useCallback, useEffect, useRef, useState } from "react"
import { sequenceSendFromRow } from "@shared/mappers.ts"
import type { SequenceSend } from "@shared/types.ts"
import { supabase } from "./supabase"

/**
 * One recipient's queue rows, so the compose sidebar can say what has gone out
 * and when the rest is due.
 *
 * Read directly under RLS with no server route in between — the same arrangement
 * as `lead_engagement`. `sends` is SELECT-only to the browser (its INSERT/UPDATE
 * grants are revoked in `schema.sql`), which is what makes these timings
 * trustworthy: the scheduler is the only writer, so a row here is a real
 * commitment rather than something the UI decided.
 *
 * Only the timing columns are selected. `sends` also holds the rendered bodies and
 * the Gmail identifiers, and pulling those into a sidebar would ship an entire
 * email per row to render one line of text.
 */

const TIMING_COLUMNS = "id, step_position, status, scheduled_at, sent_at"

/** No React in here, so both the effect and the poll can await it. */
export async function fetchSendsForLead(leadId: string): Promise<SequenceSend[]> {
  const { data, error } = await supabase
    .from("sends")
    .select(TIMING_COLUMNS)
    .eq("lead_id", leadId)
    .order("step_position", { ascending: true })

  if (error) throw new Error(error.message)

  return (data ?? []).map(sequenceSendFromRow)
}

/**
 * How often to re-read the queue.
 *
 * The rows are written by the *server* — the tick queues each follow-up only after
 * the previous email goes out — so nothing in this tab knows when one appears.
 * Slower than the engagement poll (a minute) because these move on a scale of days
 * rather than seconds: within one editing session the only realistic change is the
 * opening email going out, and the sidebar is not a live dashboard.
 */
const POLL_MS = 120_000

export interface SendsStore {
  /**
   * This lead's queue rows. **Empty means nothing has been launched yet** — which
   * is different from "not loaded", hence `loading` alongside it. A projection
   * built from an empty list is still correct: it shows the whole sequence as
   * upcoming, which is exactly what an unlaunched lead is.
   */
  sends: SequenceSend[]
  /**
   * True until the first read for the current lead has settled, so it goes back to
   * true when the lead changes. A failed poll leaves the previous rows on screen
   * rather than flipping this back.
   */
  loading: boolean
  /** Re-read now — after a launch or a cancel, which both change every row. */
  refresh: () => Promise<void>
}

/**
 * `onError` is deliberately absent, as in `useEngagement`. These timings are
 * advisory: a failed read costs the user a stale "sends in 3 days" line, and a
 * toast every two minutes on a flaky connection would be worse than the staleness.
 *
 * `leadId` may be empty — the compose view is only mounted with a lead, but the
 * hook is called unconditionally to respect the rules of hooks. An empty id skips
 * the query rather than fetching every lead's rows.
 */
export function useSends(leadId: string): SendsStore {
  /*
   * The rows are stored *with the lead they belong to*, and read back below only if
   * that still matches. Rows are matched to steps by `position`, so the previous
   * recipient's queue rendered against this one's steps would show someone else's
   * send time under this lead's follow-up — and clearing them in an effect would be
   * both a cascading render and one frame too late. Deriving makes the wrong pairing
   * unrepresentable rather than merely brief.
   */
  const [loaded, setLoaded] = useState<{ leadId: string; rows: SequenceSend[] }>({
    leadId: "",
    rows: [],
  })
  /**
   * Which lead a read has *finished* for, successfully or not. Compared against
   * `leadId` below instead of a boolean flag, for the same reason as the rows: a
   * flag left `false` from the previous lead would report the new one as loaded
   * before its query had been sent. Failures count as settled — otherwise a
   * dropped connection spins forever.
   */
  const [settledFor, setSettledFor] = useState("")

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
  const load = useCallback(() => {
    if (!leadId) return Promise.resolve()

    return fetchSendsForLead(leadId)
      .then((rows) => {
        // Tagged with the lead it was read for, so a slow response that lands after
        // the user has moved on is ignored on read rather than shown.
        if (active.current) setLoaded({ leadId, rows })
      })
      .catch((cause: unknown) => {
        // Logged, not surfaced: see the note on the hook.
        console.warn("Couldn't read the send queue", cause)
      })
      .finally(() => {
        if (active.current) setSettledFor(leadId)
      })
  }, [leadId])

  useEffect(() => {
    active.current = true
    void load()

    /*
     * Only poll a visible tab. A background tab's timers are throttled anyway, and
     * re-reading for a sidebar nobody is looking at is pure waste — so the
     * `visibilitychange` listener also fires an immediate read on return, which is
     * when the rows most need to be current.
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

  return {
    sends: loaded.leadId === leadId ? loaded.rows : [],
    // An empty `leadId` never fetches, so it is never "loading".
    loading: leadId !== "" && settledFor !== leadId,
    refresh: load,
  }
}
