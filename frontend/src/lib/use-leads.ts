import { useCallback, useEffect, useRef, useState } from "react"
import type { PostgrestError } from "@supabase/supabase-js"
import { leadFromRow, leadToRow } from "@shared/mappers.ts"
import type { NewLead } from "@shared/leads.ts"
import type { Lead } from "@shared/types.ts"
import { supabase } from "./supabase"

/**
 * The leads table, backed by Supabase.
 *
 * Queries and the hook live in one file rather than the `templates.ts` /
 * `use-templates.ts` split, because `lib/leads.ts` is already the re-export shim
 * for `shared/leads.ts` and a second `leads.ts` would be worse than this.
 *
 * `user_id` is never written: the column defaults to `auth.uid()` and RLS checks
 * it, so supplying it would be both redundant and a way to get it wrong. Nor is
 * `id` — Postgres assigns it, which is why every write reads its row back. The
 * client-invented ids this code replaced (`manual-jane@acme.com-10:00`,
 * `csv-3-jane@acme.com`) aren't UUIDs and would have failed the column type.
 */

/** Ordered oldest-first so an import lands at the bottom, where the user expects it. */
export async function fetchLeads(): Promise<Lead[]> {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: true })
    /*
     * `email` as a tiebreaker, which is not optional here. `created_at` defaults to
     * `now()` — the *statement* timestamp — so every row of a CSV import shares it
     * to the microsecond, and ordering by it alone leaves Postgres free to return
     * those rows in any order it likes. The visible symptom is a leads table that
     * reshuffles itself on reload for no reason the user did.
     */
    .order("email", { ascending: true })

  if (error) throw new Error(error.message)

  return (data ?? []).map(leadFromRow)
}

/**
 * Turn a Postgres error into something the user can act on.
 *
 * Only two codes are reachable from this file, and both are things the *user* did
 * rather than bugs: a duplicate address (23505, from the
 * `(user_id, lower(email))` unique index) and a value the column rejects (23514,
 * from the email or send-time CHECK). Postgres's own wording for those names the
 * constraint, not the mistake.
 */
function describeWriteError(error: PostgrestError, email: string): string {
  if (error.code === "23505") {
    return `${email} is already in your database.`
  }
  if (error.code === "23514") {
    return `${email} has a value the database rejected — check the email address and send time.`
  }
  return error.message
}

export async function createLead(lead: NewLead): Promise<Lead> {
  const { data, error } = await supabase
    .from("leads")
    .insert(leadToRow(lead))
    .select("*")
    .single()

  if (error) throw new Error(describeWriteError(error, lead.email))

  return leadFromRow(data)
}

/**
 * Overwrite one lead's editable columns.
 *
 * Takes a whole `NewLead` rather than a patch because `leadToRow` emits every
 * writable column — a partial input would blank the fields it didn't mention.
 * `status` and `replied_at` are outside that set by construction, so this cannot
 * disturb a send in flight.
 */
export async function updateLead(id: string, lead: NewLead): Promise<Lead> {
  const { data, error } = await supabase
    .from("leads")
    .update(leadToRow(lead))
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(describeWriteError(error, lead.email))

  return leadFromRow(data)
}

/** The one column the grid edits inline, so it doesn't need the whole row. */
export async function updateSendTime(id: string, sendTimeIST: string): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ send_time_ist: sendTimeIST })
    .eq("id", id)

  if (error) throw new Error(error.message)
}

export async function deleteLead(id: string): Promise<void> {
  /*
   * `select()` so a delete that matched nothing is distinguishable from one that
   * worked. Without it the row would vanish from the table while still sitting in
   * the database, and come back on the next reload.
   */
  const { data, error } = await supabase.from("leads").delete().eq("id", id).select("id")

  if (error) throw new Error(error.message)
  if (!data || data.length === 0) throw new Error("That lead no longer exists.")
}

/**
 * Insert many leads in one statement, returning them with their real ids.
 *
 * One statement means one failure: if any row violates a constraint, none of them
 * insert. That's why the caller filters duplicates first and `parseLeadsCsv`
 * validates every field — by the time rows reach here, the remaining ways to fail
 * are ones nothing client-side could have predicted.
 */
export async function insertLeads(leads: NewLead[]): Promise<Lead[]> {
  if (leads.length === 0) return []

  const { data, error } = await supabase
    .from("leads")
    .insert(leads.map(leadToRow))
    .select("*")

  if (error) throw new Error(error.message)

  /*
   * Sorted by email to match `fetchLeads`. These rows all share one `created_at`
   * (see the note there), so they are last in the list either way — but their order
   * *among themselves* is this tiebreaker's, and sorting here is what stops the
   * table from rearranging on the next reload.
   */
  return (data ?? [])
    .map(leadFromRow)
    .sort((a, b) => a.email.localeCompare(b.email))
}

/** What an import actually did, for the summary toast. */
export interface ImportOutcome {
  inserted: number
  /**
   * Addresses skipped as duplicates — not an error. Covers both senses: already in
   * the database, and appearing twice within the same file.
   */
  duplicates: string[]
}

export interface LeadsStore {
  leads: Lead[]
  loading: boolean
  /** A failed *read*. Write failures go to the `onError` callback. */
  error: string | null
  /** Resolves to the saved lead (with its database id), or null if the write failed. */
  create: (lead: NewLead) => Promise<Lead | null>
  update: (id: string, lead: NewLead) => Promise<Lead | null>
  /**
   * Delete a lead. Resolves `true` only if the row is actually gone.
   *
   * The boolean is load-bearing: the caller drops the lead's cascaded
   * `sequence_steps` from memory on success, and doing that for a lead that still
   * exists would make the compose flow treat it as having no sequence and write a
   * blank one over its real emails.
   */
  remove: (id: string) => Promise<boolean>
  /** Inline grid edit — optimistic, written on a debounce. */
  setSendTime: (id: string, sendTimeIST: string) => void
  /** Bulk insert, skipping addresses already present. */
  importLeads: (leads: NewLead[]) => Promise<ImportOutcome | null>
  /**
   * Adopt a status the **server** has already written.
   *
   * Not a way to set one: `leads.status` past `draft` belongs to the scheduler, and
   * the browser has no business deciding a lead is `sending`. Launch and cancel go
   * through their routes and pass the status those routes return, so this only ever
   * catches local state up to a fact.
   */
  adoptStatus: (id: string, status: Lead["status"]) => void
  /** Write any pending debounced send-time edits now. */
  flush: () => Promise<void>
}

/**
 * Long enough to coalesce arrow-key nudges on the time input, short enough that
 * the write lands before the user moves on.
 */
const SAVE_DEBOUNCE_MS = 600

export function useLeads(onError: (message: string) => void): LeadsStore {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * Pending send-time writes, keyed by lead id so editing several rows queues one
   * write each. A ref rather than state: it must not re-render, and `flush` has to
   * see the latest value rather than a closed-over snapshot.
   */
  const pending = useRef(new Map<string, string>())
  const timer = useRef<number | null>(null)

  /*
   * `onError` behind a ref so the debounce callbacks don't depend on it. Callers
   * pass an inline arrow, which would otherwise rebuild `flush` every render and
   * restart the timer — meaning a user who keeps typing never gets a save.
   *
   * Assigned in an effect, not during render: mutating a ref while rendering is
   * unsafe under concurrent rendering. Errors only surface from handlers and
   * timers, so post-commit is soon enough.
   */
  const report = useRef(onError)

  useEffect(() => {
    report.current = onError
  }, [onError])

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }

    const queued = [...pending.current.entries()]
    pending.current.clear()

    // Sequential: a handful of one-column updates, and one failing shouldn't leave
    // the others' outcome ambiguous.
    for (const [id, sendTimeIST] of queued) {
      try {
        await updateSendTime(id, sendTimeIST)
      } catch (cause) {
        report.current(
          cause instanceof Error ? cause.message : "Couldn't save the send time."
        )
      }
    }
  }, [])

  useEffect(() => {
    // Guards a resolved read landing after unmount, and StrictMode's double-mount.
    let active = true

    fetchLeads()
      .then((rows) => {
        if (!active) return
        setLeads(rows)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : "Couldn't load your leads.")
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  /*
   * Flush on unmount and on tab close. A send time nudged and then navigated away
   * from is exactly the edit a debounce loses.
   */
  useEffect(() => {
    const onHide = () => void flush()
    window.addEventListener("pagehide", onHide)

    return () => {
      window.removeEventListener("pagehide", onHide)
      void flush()
    }
  }, [flush])

  const create = useCallback(async (lead: NewLead): Promise<Lead | null> => {
    try {
      const saved = await createLead(lead)
      setLeads((prev) => [...prev, saved])
      return saved
    } catch (cause) {
      report.current(cause instanceof Error ? cause.message : "Couldn't add the lead.")
      return null
    }
  }, [])

  const update = useCallback(
    async (id: string, lead: NewLead): Promise<Lead | null> => {
      /*
       * Flush first: a queued send-time write for this row would land *after* the
       * update and overwrite the dialog's value with the grid's older one.
       */
      await flush()

      try {
        const saved = await updateLead(id, lead)
        setLeads((prev) => prev.map((l) => (l.id === id ? saved : l)))
        return saved
      } catch (cause) {
        report.current(cause instanceof Error ? cause.message : "Couldn't save the lead.")
        return null
      }
    },
    [flush]
  )

  const remove = useCallback(async (id: string): Promise<boolean> => {
    // Drop any queued send-time write for this row — the row is about to be gone.
    pending.current.delete(id)

    try {
      await deleteLead(id)
      setLeads((prev) => prev.filter((l) => l.id !== id))
      return true
    } catch (cause) {
      report.current(cause instanceof Error ? cause.message : "Couldn't delete the lead.")
      return false
    }
  }, [])

  const setSendTime = useCallback(
    (id: string, sendTimeIST: string) => {
      // Optimistic: the input is a controlled component, so it can't wait for a
      // round trip without stuttering as you type.
      setLeads((prev) =>
        prev.map((l) => (l.id === id ? { ...l, sendTimeIST } : l))
      )

      pending.current.set(id, sendTimeIST)

      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [flush]
  )

  const importLeads = useCallback(
    async (incoming: NewLead[]): Promise<ImportOutcome | null> => {
      /*
       * Filter duplicates here rather than letting Postgres refuse them. The
       * `(user_id, lower(email))` unique index makes re-importing a CSV a 23505 —
       * and because the insert is one statement, that single collision would reject
       * every other row in the file. Skipping them turns "nothing imported" into
       * "47 imported, 3 already present".
       *
       * Compared lowercased against the current list; `parseLeadsCsv` has already
       * lowercased its side.
       */
      const seen = new Set(leads.map((l) => l.email.toLowerCase()))
      const duplicates: string[] = []
      const fresh: NewLead[] = []

      for (const lead of incoming) {
        const key = lead.email.toLowerCase()
        // `seen` grows as we go, so a file containing the same address twice
        // reports the second one rather than failing the insert on itself.
        if (seen.has(key)) {
          duplicates.push(lead.email)
          continue
        }
        seen.add(key)
        fresh.push(lead)
      }

      try {
        const saved = await insertLeads(fresh)
        setLeads((prev) => [...prev, ...saved])
        return { inserted: saved.length, duplicates }
      } catch (cause) {
        report.current(
          cause instanceof Error ? cause.message : "Couldn't import those leads."
        )
        return null
      }
    },
    [leads]
  )

  /**
   * Reflect a status the server has just written.
   *
   * Local-only by design, and correct because it is only ever called with a status
   * that came *back* from `/launch` or `/cancel`. Writing `leads.status` from the
   * browser is what this avoids: the scheduler owns that column, and a `scheduled`
   * written here with nothing queued behind it would be a lie that survives a
   * reload.
   */
  const adoptStatus = useCallback((id: string, status: Lead["status"]) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, status } : l)))
  }, [])

  return {
    leads,
    loading,
    error,
    create,
    update,
    remove,
    setSendTime,
    importLeads,
    adoptStatus,
    flush,
  }
}
