import { createClient } from "@supabase/supabase-js"
import type { PostgrestError } from "@supabase/supabase-js"
import { env } from "./env.ts"
import type { Database, Tables, TablesInsert, TablesUpdate } from "../../shared/database.types.ts"

/**
 * The server's Supabase client, holding the **secret key** — it bypasses RLS
 * entirely. Every query here is therefore responsible for its own `user_id`
 * scoping; nothing is enforced for us.
 *
 * The `<Database>` generic is the point of this file. Without it supabase-js
 * returns `any`, and `send.thread_id` (instead of `send.gmail_thread_id`) would
 * compile clean and silently break follow-up threading in production.
 */
export const db = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: {
    // A server has no browser session to persist or refresh, and leaving these
    // on makes the client write to a non-existent storage adapter.
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    headers: { "X-Client-Info": "cold-email-server" },
  },
})

/**
 * Short aliases for the generated row shapes. Derived, never hand-written: a
 * column rename in `schema.sql` then breaks the build at every use site instead
 * of turning into an `undefined` at runtime.
 */
export type GmailAccountRow = Tables<"gmail_accounts">
export type LeadRow = Tables<"leads">
export type SendRow = Tables<"sends">
export type SequenceStepRow = Tables<"sequence_steps">
export type TemplateStepRow = Tables<"template_steps">
export type SettingsRow = Tables<"settings">
export type AttachmentRow = Tables<"attachments">
export type EventRow = Tables<"events">

export type SendInsert = TablesInsert<"sends">
export type SendUpdate = TablesUpdate<"sends">
export type EventInsert = TablesInsert<"events">
export type GmailAccountUpdate = TablesUpdate<"gmail_accounts">

/** A query that failed at the database, as opposed to returning no rows. */
export class DatabaseError extends Error {
  override readonly name = "DatabaseError"

  constructor(
    /** What was being attempted, e.g. "claim due sends". */
    readonly operation: string,
    override readonly cause: PostgrestError
  ) {
    super(`${operation} failed: ${cause.message}${cause.code ? ` (${cause.code})` : ""}`)
  }
}

/** A row was required and the query matched none. */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError"
}

/**
 * Unwrap a supabase-js result, throwing on error.
 *
 * Every call site would otherwise repeat `if (error) throw`, and the ones that
 * forget silently treat a failed query as an empty result — which for the
 * scheduler means "nothing due" rather than "the database is down".
 */
export async function unwrap<T>(
  operation: string,
  query: PromiseLike<{ data: T; error: PostgrestError | null }>
): Promise<T> {
  const { data, error } = await query
  if (error) throw new DatabaseError(operation, error)
  return data
}

/**
 * Like `unwrap`, but a missing row is an error rather than a `null` to check.
 *
 * The parameter is `data: T` and the return is `NonNullable<T>`, which reads
 * backwards but is the only shape that works: supabase-js types `data` as
 * `Row | null` on every single-row query, so declaring the parameter as
 * `T | null` would infer `T = Row | null` and hand the caller back a value that
 * is still nullable — exactly the `!` this function exists to remove.
 */
export async function unwrapRequired<T>(
  operation: string,
  query: PromiseLike<{ data: T; error: PostgrestError | null }>
): Promise<NonNullable<T>> {
  const data = await unwrap(operation, query)
  if (data === null || data === undefined) {
    throw new NotFoundError(`${operation} found no matching row.`)
  }
  return data
}

/**
 * `unwrap` for a multi-row select.
 *
 * supabase-js types `data` as `T[] | null` because it is null on error — and the
 * error has already been thrown by then, so the null is unreachable. Collapsing
 * it to `[]` here is what keeps every caller free of a `?? []` that would
 * otherwise hide a real failure behind an innocent-looking empty list.
 */
export async function unwrapMany<T>(
  operation: string,
  query: PromiseLike<{ data: T[] | null; error: PostgrestError | null }>
): Promise<T[]> {
  return (await unwrap(operation, query)) ?? []
}
