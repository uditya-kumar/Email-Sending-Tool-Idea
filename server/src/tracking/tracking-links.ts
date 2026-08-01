import { sign, verify } from "../crypto.ts"
import { env } from "../env.ts"

/**
 * The pixel and click URLs that go inside an email, and the verification of
 * those URLs when a recipient's mail client comes back.
 *
 * The HMAC is the load-bearing part. `/t/c/:id?u=<url>` without a signature is a
 * free open redirect on your domain — spammers find those, and once one is in a
 * blocklist every email you send is affected.
 */

/** A destination URL that failed its signature check, or isn't a web URL at all. */
export class InvalidTrackingUrlError extends Error {
  override readonly name = "InvalidTrackingUrlError"
}

/**
 * Only http(s) is wrapped. `mailto:`, `tel:` and `#anchor` links have nothing to
 * track and would break if rewritten, and allowing `javascript:` through the
 * redirect would be an XSS vector in the recipient's browser.
 */
export function isTrackableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export class TrackingLinks {
  constructor(
    /**
     * Public origin the links point at. Separate from FRONTEND_URL because this
     * must be reachable by Gmail's image proxy — a tunnel URL in development, and
     * ideally a CNAME'd subdomain in production rather than `*.onrender.com`.
     */
    private readonly baseUrl: string = env.TRACKING_BASE_URL
  ) {}

  /**
   * The 1×1 open pixel.
   *
   * `.gif` is in the path, not a query parameter: some clients and proxies only
   * prefetch URLs that look like images, and a bare path gets skipped.
   */
  pixelUrl(trackingId: string): string {
    return `${this.baseUrl}/t/o/${trackingId}.gif`
  }

  /**
   * Rewrite one destination URL into a signed redirect through this server.
   *
   * The signature covers `trackingId` **and** the URL together, so a signature
   * lifted from one email cannot be replayed to redirect a different one — and
   * neither part can be edited independently.
   */
  wrap(url: string, trackingId: string): string {
    const encoded = Buffer.from(url, "utf8").toString("base64url")
    const signature = sign(`${trackingId}:${encoded}`)
    return `${this.baseUrl}/t/c/${trackingId}?u=${encoded}&s=${signature}`
  }

  /**
   * Recover the original URL from a click, or throw.
   *
   * Throws rather than returning null so a bad signature cannot accidentally be
   * treated as "no redirect" and fall through to something permissive.
   */
  unwrap(trackingId: string, encoded: string, signature: string): string {
    if (!verify(`${trackingId}:${encoded}`, signature)) {
      throw new InvalidTrackingUrlError("Tracking link signature does not match.")
    }

    const url = Buffer.from(encoded, "base64url").toString("utf8")

    // Re-checked after decoding: the signature proves we produced this string,
    // but a stored `javascript:` URL would have been signed just as happily.
    if (!isTrackableUrl(url)) {
      throw new InvalidTrackingUrlError(`Refusing to redirect to a non-http(s) URL: ${url}`)
    }

    return url
  }
}

export const trackingLinks = new TrackingLinks()

/**
 * A 1×1 transparent GIF, inline so the pixel endpoint never touches the disk.
 * 42 bytes — about as small as a valid GIF gets.
 */
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
)
