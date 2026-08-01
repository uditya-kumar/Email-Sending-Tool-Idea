import { Router, type RequestHandler } from "express"
import { secretsMatch } from "../crypto.ts"
import { env } from "../env.ts"
import { ForbiddenError } from "../http/errors.ts"
import { route } from "../http/handler.ts"
import { loggerFor } from "../logger.ts"
import { runTick } from "../scheduler/tick.ts"

/**
 * `POST /api/cron/tick` — the send loop, triggered from outside.
 *
 * The in-process `node-cron` schedule is the normal driver; this exists for the
 * deployments where it can't be. Render and Railway both sleep or recycle a free
 * instance, which stops an in-process cron dead, so the fallback is an external
 * pinger (cron-job.org, GitHub Actions, Supabase pg_cron) hitting this every
 * minute with `SCHEDULER_ENABLED=false`.
 *
 * It is not authenticated with a Supabase session — a pinger has none — so a
 * shared secret stands in. `CRON_SECRET` being optional in `env.ts` means this
 * route **fails closed**: with no secret configured it 403s rather than exposing
 * an unauthenticated way to make the server send email.
 */

const log = loggerFor("routes/cron")

export const cronRouter = Router()

/**
 * The only thing standing between a stranger and the send loop.
 *
 * The comparison goes through `secretsMatch` (constant-time) rather than `===`,
 * which would leak the secret's length and prefix through response timing.
 */
const requireCronSecret: RequestHandler = (req, _res, next) => {
  const expected = env.CRON_SECRET

  if (!expected) {
    log.warn("Rejected a cron trigger: CRON_SECRET is not configured")
    next(new ForbiddenError("The cron endpoint is disabled."))
    return
  }

  const presented = bearerToken(req.get("authorization")) ?? req.get("x-cron-secret")

  if (!presented || !secretsMatch(expected, presented)) {
    log.warn({ ip: req.ip }, "Rejected a cron trigger with a bad secret")
    next(new ForbiddenError("Invalid cron secret."))
    return
  }

  next()
}

cronRouter.use(requireCronSecret)

cronRouter.post(
  "/tick",
  route({}, async () => {
    /*
     * Awaited, not fire-and-forget: the pinger's timeout is the only backstop on
     * a tick that hangs, and returning the counts is what makes the endpoint
     * debuggable by curl. `runTick` already refuses to overlap itself, so a
     * pinger firing again mid-run is harmless.
     */
    const result = await runTick()

    return { ok: true, ...result }
  })
)

/**
 * The tick's own view of itself, for a quick check that the loop is alive without
 * triggering a send. Behind the same secret — the skip reasons name account ids.
 */
cronRouter.get(
  "/status",
  route({}, () => ({
    schedulerEnabled: env.SCHEDULER_ENABLED,
    // Not `Date.now()` in a template — an explicit ISO string, so a log scrape
    // gets something sortable.
    now: new Date().toISOString(),
  }))
)

/** `Authorization: Bearer <secret>` → `<secret>`. */
function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const [scheme, value] = header.split(" ")
  if (!value || scheme?.toLowerCase() !== "bearer") return undefined
  return value
}

