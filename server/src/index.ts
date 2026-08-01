import cors from "cors"
import express from "express"
import cron from "node-cron"
import { env, isProduction } from "./env.ts"
import { errorMiddleware } from "./http/handler.ts"
import { NotFoundHttpError } from "./http/errors.ts"
import { logger } from "./logger.ts"
import { accountsRouter, authRouter } from "./routes/auth.ts"
import { cronRouter } from "./routes/cron.ts"
import { leadsRouter } from "./routes/leads.ts"
import { testSendRouter } from "./routes/test-send.ts"
import { trackingRouter } from "./routes/tracking.ts"
import { sendQueue } from "./scheduler/send-queue.ts"
import { runTick } from "./scheduler/tick.ts"

/**
 * The whole server: four private routers, two public tracking endpoints, one
 * cron schedule.
 *
 * Deliberately small. All CRUD lives in the browser against Supabase under RLS
 * (see `CLAUDE.md`), so this process only does the four things a browser cannot:
 * hold the Google client secret, run a clock, answer a stranger's mail client,
 * and read a Gmail thread for replies.
 */

const app = express()

/**
 * Behind Render/Fly/nginx, `req.ip` is the proxy's address unless this is set —
 * and `req.ip` is what lands in `events.ip`. `1` rather than `true`: trusting the
 * whole chain lets a client forge `X-Forwarded-For` at will.
 */
app.set("trust proxy", 1)

// No `X-Powered-By: Express`. Free, and one fewer thing advertised to a scanner
// on a public tracking endpoint.
app.disable("x-powered-by")

/**
 * CORS for exactly one origin — the frontend.
 *
 * The tracking routes are mounted *before* this so they stay reachable by a mail
 * client from any origin: an image or a redirect is not a cross-origin XHR and
 * must not be gated on an `Origin` header the client will never send.
 */
app.use("/t", trackingRouter)

app.use(cors({ origin: env.FRONTEND_URL, credentials: false }))

/**
 * 100 kB rather than the 1 MB default. The largest legitimate body is a Tiptap
 * HTML step, and attachments go to Supabase Storage directly from the browser —
 * never through here.
 */
app.use(express.json({ limit: "100kb" }))

/** Uptime ping. Deliberately does not touch the database — a health check that
 * fails when Supabase blips would make a host recycle a server that is fine. */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, scheduler: env.SCHEDULER_ENABLED })
})

app.use("/api/auth", authRouter)
app.use("/api/accounts", accountsRouter)
app.use("/api/leads", leadsRouter)
app.use("/api/test-send", testSendRouter)
app.use("/api/cron", cronRouter)

/** An unmatched route as a typed 404, so the response shape matches every other
 * error instead of Express's default HTML page. */
app.use((req, _res, next) => {
  next(new NotFoundHttpError(`No route for ${req.method} ${req.path}.`))
})

// Last, always: Express only treats a four-argument function as error middleware,
// and only reaches it after every route has been mounted.
app.use(errorMiddleware)

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      frontend: env.FRONTEND_URL,
      tracking: env.TRACKING_BASE_URL,
      scheduler: env.SCHEDULER_ENABLED,
    },
    "Server listening"
  )

  warnAboutClock()
  void recoverStaleClaims()
})

/**
 * The send loop.
 *
 * Every minute, and `runTick` decides for itself whether anything is due —
 * cheaper and far more robust than trying to schedule per-lead cron entries. Off
 * when an external pinger drives `POST /api/cron/tick` instead, which is the
 * pattern for a host that sleeps (`BACKEND_PLAN.md` §9).
 */
const tickSchedule = env.SCHEDULER_ENABLED
  ? cron.schedule(
      "* * * * *",
      () => {
        void runTick().catch((error: unknown) => {
          // A throw out of the scheduled callback would otherwise be an
          // unhandled rejection and, on newer Node, kill the process.
          logger.error({ err: error }, "Tick failed")
        })
      },
      // UTC explicitly: all IST math is Luxon's, and a host whose local timezone
      // is something else must not shift when the cron fires.
      { timezone: "UTC" }
    )
  : null

if (!tickSchedule) {
  logger.warn(
    "SCHEDULER_ENABLED=false — nothing will send unless POST /api/cron/tick is called externally"
  )
}

/**
 * Recover rows a crash left mid-claim.
 *
 * A row stuck in `sending` matches no future claim (`claim_due_sends` only takes
 * `pending`), so without this a `kill -9` at the wrong moment would silently
 * strand an email forever rather than retrying it.
 */
async function recoverStaleClaims(): Promise<void> {
  try {
    const released = await sendQueue.releaseStaleClaims()
    if (released > 0) {
      logger.warn({ released }, "Released sends left claimed by a previous run")
    }
  } catch (error) {
    logger.error({ err: error }, "Could not release stale claims at boot")
  }
}

/**
 * The scheduler's correctness depends on the host clock, and a wrong one is
 * invisible — emails just go out at the wrong time. Worth one line at boot.
 */
function warnAboutClock(): void {
  if (process.env.TZ !== "UTC") {
    logger.warn(
      { TZ: process.env.TZ ?? "(unset)" },
      "TZ is not UTC. All IST math is Luxon's so this is not fatal, but set TZ=UTC to keep logs and cron aligned"
    )
  }
}

/**
 * Shut down without cutting a send in half.
 *
 * `server.close()` stops accepting connections and waits for in-flight ones,
 * which matters most for a tick mid-`messages.send`: killing it there could send
 * the email and never record it, and the next tick would send it again.
 */
function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down")

  tickSchedule?.stop()

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error while closing the server")
      process.exit(1)
    }
    process.exit(0)
  })

  // A hung connection must not block a deploy indefinitely.
  setTimeout(() => {
    logger.warn("Forcing exit after shutdown timeout")
    process.exit(1)
  }, 10_000).unref()
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

/*
 * A rejection that reaches here is a bug, but crashing a single-instance server
 * that owns the scheduler is worse than logging it — a restart loop sends
 * nothing at all. In production it is logged and the process kept alive; in
 * development it is loud, because that is when it should be fixed.
 */
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection")
  if (!isProduction) process.exitCode = 1
})

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception")
  // Genuinely unsafe to continue: the process state is unknown. The host restarts
  // it, and `releaseStaleClaims()` above cleans up whatever the crash stranded.
  process.exit(1)
})

export { app }
