import { db, unwrap, unwrapMany, type EventInsert } from "../db.ts"
import { loggerFor } from "../logger.ts"
import type { EventType } from "../../../shared/types.ts"

/**
 * Writes to `events` — opens, clicks and replies.
 *
 * The browser can only SELECT this table (its write grants are revoked in
 * `schema.sql`), so every row in it comes through here. That is what makes the
 * engagement numbers trustworthy rather than something the UI could fabricate.
 */

const log = loggerFor("events")

export interface RecordEventInput {
  sendId: string
  userId: string
  type: EventType
  /** Clicks only: the destination that was followed. */
  url?: string | undefined
  userAgent?: string | undefined
  ip?: string | undefined
}

/**
 * Mail providers that fetch images through a rewriting proxy instead of letting
 * the reader's client connect to us.
 *
 * These are **labelled, not dropped.** Gmail serves every image in every message
 * through this proxy — including the fetch caused by a human opening the message —
 * so discarding the user agent means a Gmail recipient shows zero opens forever.
 * Verified 2026-08-02: an email delivered at 04:23:05 got no pixel request at all
 * until the message was opened, then exactly one per open (04:32:54, 04:33:44).
 * The proxy user agent said nothing about whether a person was involved; the
 * *timing* did.
 *
 * What the marker is good for is the caveat. A provider that prefetches at
 * delivery (Apple Mail Privacy Protection is the usual one) produces a single open
 * seconds after the send and none afterwards, which is why the UI leans on "two
 * or more opens" rather than on this list.
 *
 * Kept in sync with the same list in `lead_engagement` (`supabase/schema.sql`),
 * which recomputes this from `events.user_agent` for the `proxy_opens` count.
 *
 * Deliberately not used to dedupe: the sibling-pixel problem it looks like it
 * could solve is handled by grouping opens into reads in the view instead.
 */
const PROXY_AGENT_MARKERS = ["googleimageproxy", "yahoomailproxy", "ggpht.com"]

/**
 * Was this pixel fetched through a mail provider's image proxy?
 *
 * Only ever used to annotate an open — see the note above on why it must not be
 * used to reject one.
 */
export function isProxyFetch(userAgent: string | undefined): boolean {
  if (!userAgent) return false
  const agent = userAgent.toLowerCase()
  return PROXY_AGENT_MARKERS.some((marker) => agent.includes(marker))
}

export async function recordEvent(input: RecordEventInput): Promise<void> {
  const row: EventInsert = {
    send_id: input.sendId,
    user_id: input.userId,
    type: input.type,
    ...(input.url ? { url: input.url } : {}),
    ...(input.userAgent ? { user_agent: input.userAgent.slice(0, 500) } : {}),
    // The column is `inet`; an unparseable value would be a 22P02, so a proxied
    // request with a comma-separated X-Forwarded-For is dropped rather than
    // failing the pixel it was attached to.
    ...(input.ip && isPlausibleIp(input.ip) ? { ip: input.ip } : {}),
  }

  await unwrap("record event", db.from("events").insert(row).select("id"))
}

/**
 * Has this send already recorded an event of this type recently?
 *
 * Opens are the reason this exists: a client that reloads the message, or a proxy
 * that fetches the pixel twice, would otherwise look like two reads. Clicks are
 * genuinely repeatable, so the caller decides whether to dedupe.
 */
export async function hasRecentEvent(
  sendId: string,
  type: EventType,
  withinSeconds: number
): Promise<boolean> {
  const since = new Date(Date.now() - withinSeconds * 1000).toISOString()

  const rows = await unwrapMany(
    "check recent event",
    db
      .from("events")
      .select("id")
      .eq("send_id", sendId)
      .eq("type", type)
      .gte("created_at", since)
      .limit(1)
  )

  return rows.length > 0
}

/**
 * Record an open unless it duplicates one from seconds ago **on the same send**.
 *
 * Per-send is as far as this can go, and it is deliberately not where the
 * user-facing count is decided. Opening a thread makes the client fetch the pixel
 * of every message in it, so one read of a three-step sequence arrives here as
 * three requests — different `send_id`s, sometimes 50ms apart. Widening this
 * check to the lead would not fix that: the requests are concurrent, so each can
 * pass a read-then-insert test before the other's row is visible. The reads-not-
 * fetches grouping therefore lives in `lead_engagement`, which counts at read
 * time and cannot race; this window stays as a cheap guard on row volume from a
 * single client re-fetching one pixel.
 *
 * A proxied fetch is **recorded**, not skipped — see `PROXY_AGENT_MARKERS`. The
 * user agent is stored as-is so the proxy question can be asked later, at display
 * time, without having thrown the open away.
 *
 * Never throws: a tracking pixel must return its GIF whatever happens, because
 * the alternative is a broken-image icon in a cold email — a worse outcome than a
 * lost statistic.
 */
export async function recordOpen(input: RecordEventInput): Promise<boolean> {
  try {
    if (await hasRecentEvent(input.sendId, "open", 10)) return false

    await recordEvent({ ...input, type: "open" })
    return true
  } catch (error) {
    log.warn({ err: error, sendId: input.sendId }, "Could not record open")
    return false
  }
}

/** IPv4/IPv6 shape check — enough to keep `inet` from rejecting the insert. */
function isPlausibleIp(value: string): boolean {
  return /^[0-9a-f:.]+$/i.test(value) && value.length <= 45
}
