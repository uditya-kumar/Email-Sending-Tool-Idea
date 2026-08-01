import { Router, type Response } from "express"
import { recordEvent, recordOpen } from "../data/events.ts"
import { route } from "../http/handler.ts"
import {
  clickQuerySchema,
  trackingParamsSchema,
  type ClickQuery,
  type TrackingParams,
} from "../http/schemas.ts"
import { loggerFor } from "../logger.ts"
import { sendQueue } from "../scheduler/send-queue.ts"
import { TRANSPARENT_GIF, trackingLinks } from "../tracking/tracking-links.ts"

/**
 * The two public endpoints — the only routes in the app with no authentication,
 * because the caller is a stranger's mail client.
 *
 * Both are written to be **unfailable from the recipient's point of view**: the
 * pixel always returns its GIF and the click always redirects, whatever the
 * database does. A tracking failure must never show up as a broken image or a
 * dead link inside an email that has already been delivered.
 *
 * Neither endpoint takes an id that means anything: `tracking_id` is a random
 * UUID distinct from `sends.id`, so a forwarded email leaks nothing about the
 * database and guessing one gains an attacker only the ability to fake an open on
 * a row they cannot identify.
 */

const log = loggerFor("routes/tracking")

export const trackingRouter = Router()

/**
 * `GET /t/o/:trackingId.gif` — the open pixel.
 *
 * The `.gif` is matched as part of the parameter and stripped below rather than
 * written into the path pattern. Express 5's router treats a parameter as ending
 * at the next `/`, so `:trackingId` captures `abc-….gif` whole — which is both
 * simpler and immune to how partial-segment patterns are parsed.
 *
 * The extension is in the URL at all because some clients and image proxies only
 * prefetch URLs that look like an image file.
 */
trackingRouter.get(
  "/o/:trackingId",
  route({}, async ({ req, res }) => {
    // Respond first, count second. The GIF does not depend on any of the work
    // below, and a slow database must not delay rendering the message.
    sendGif(res)

    const trackingId = stripExtension(pathValue(req.params.trackingId))

    try {
      if (!isUuid(trackingId)) return

      const send = await sendQueue.findByTrackingId(trackingId)

      // A stale pixel from a deleted lead, or a probe. Silently ignored — there
      // is nothing useful to say to whoever asked.
      if (!send) {
        log.debug({ trackingId }, "Open pixel for an unknown send")
        return
      }

      await recordOpen({
        sendId: send.id,
        userId: send.user_id,
        type: "open",
        ...userAgentOf(req.get("user-agent")),
        ...ipOf(req.ip),
      })
    } catch (error) {
      // `recordOpen` swallows its own failures; this catches the lookup.
      log.warn({ err: error, trackingId }, "Could not record open")
    }
  })
)

/**
 * `GET /t/c/:trackingId?u=<base64url>&s=<hmac>` — the click redirect.
 *
 * The signature is not optional: without it this is an open redirect on the same
 * domain the emails are sent from, which is exactly what a spammer looks for and
 * what gets a sending domain blocklisted. An unsigned or edited link therefore
 * 400s rather than redirecting anywhere at all.
 */
trackingRouter.get(
  "/c/:trackingId",
  route<unknown, TrackingParams, ClickQuery>(
    { params: trackingParamsSchema, query: clickQuerySchema },
    async ({ params, query, req, res }) => {
      const { trackingId } = params

      // Verified before anything else, and before the destination is even
      // decoded: nothing about this request is trustworthy until it passes.
      const url = trackingLinks.unwrap(trackingId, query.u, query.s)

      // 302, not 301: a permanent redirect gets cached by the browser and the
      // recipient's second click would never reach us.
      res.redirect(302, url)

      try {
        const send = await sendQueue.findByTrackingId(trackingId)

        if (!send) {
          log.debug({ trackingId }, "Click for an unknown send")
          return
        }

        // Not deduped, unlike opens: clicking the same link twice is a real
        // second click, and repeat clicks are a genuine interest signal.
        await recordEvent({
          sendId: send.id,
          userId: send.user_id,
          type: "click",
          url,
          ...userAgentOf(req.get("user-agent")),
          ...ipOf(req.ip),
        })
      } catch (error) {
        log.warn({ err: error, trackingId }, "Could not record click")
      }
    }
  )
)

/**
 * Write the pixel.
 *
 * The cache headers are the point: without them the recipient's client caches the
 * image and a second read of the message is invisible. `Content-Length` is set
 * explicitly so the response cannot be left hanging by a proxy that dislikes
 * chunked encoding on an image.
 */
function sendGif(res: Response): void {
  res
    .status(200)
    .set({
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
    })
    .end(TRANSPARENT_GIF)
}

/**
 * One path parameter as a string.
 *
 * Express 5 types every `req.params` value as `string | string[]` because a
 * repeated parameter pattern can capture several. Ours can't, but the type is
 * honest and narrowing it here is cheaper than an `as string` at each use.
 */
function pathValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

/** `"<uuid>.gif"` → `"<uuid>"`, and tolerant of a request without the extension. */
function stripExtension(value: string): string {
  return value.replace(/\.gif$/i, "")
}

/**
 * Reject a non-UUID before it reaches Postgres.
 *
 * `tracking_id` is a `uuid` column, so a garbage path segment would be a 22P02
 * database error rather than a miss — and this endpoint is public, so crawlers
 * will supply garbage.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** Conditional spread: `exactOptionalPropertyTypes` forbids an explicit `undefined`. */
function userAgentOf(value: string | undefined): { userAgent?: string } {
  return value ? { userAgent: value } : {}
}

function ipOf(value: string | undefined): { ip?: string } {
  return value ? { ip: value } : {}
}
