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
 * Gmail prefetches every image in a message through this proxy before the
 * recipient has seen anything, so a pixel hit from it says nothing about a human.
 * Filtering it is the difference between an open rate and a noise rate.
 */
const PROXY_AGENT_MARKERS = ["googleimageproxy", "yahoomailproxy", "ggpht.com"]

/** Is this pixel request a mail provider's prefetch rather than a reader? */
export function isProxyPrefetch(userAgent: string | undefined): boolean {
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
 * Record an open unless it is a proxy prefetch or a duplicate.
 *
 * Never throws: a tracking pixel must return its GIF whatever happens, because
 * the alternative is a broken-image icon in a cold email — a worse outcome than a
 * lost statistic.
 */
export async function recordOpen(input: RecordEventInput): Promise<boolean> {
  try {
    if (isProxyPrefetch(input.userAgent)) {
      log.debug({ sendId: input.sendId }, "Ignoring proxy prefetch of open pixel")
      return false
    }

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
