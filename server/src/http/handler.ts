import type { NextFunction, Request, RequestHandler, Response } from "express"
import { ZodError, type z } from "zod"
import { BadRequestError, HttpError } from "./errors.ts"
import { DatabaseError, NotFoundError } from "../db.ts"
import { AccountNeedsReauthError } from "../email/accounts.ts"
import {
  GmailAuthError,
  GmailMessageError,
  GmailRateLimitError,
} from "../email/gmail-mailer.ts"
import { EmptyStepError } from "../render/email-renderer.ts"
import { InvalidTrackingUrlError } from "../tracking/tracking-links.ts"
import { logger } from "../logger.ts"

/**
 * Express plumbing, kept in one file so routes contain only business logic.
 *
 * Express 5 does forward a rejected promise to the error middleware, so `route`
 * is not strictly required for that — its real job is the **typed request**:
 * `route(schema, ({ body }) => …)` hands the handler an already-parsed body
 * whose type is inferred from the schema, which is what removes every `as` and
 * every `req.body.foo!` from the route files.
 */

/** What a validated handler receives instead of the raw Express request. */
export interface Validated<TBody, TParams, TQuery> {
  body: TBody
  params: TParams
  query: TQuery
  req: Request
  res: Response
}

interface Schemas {
  body?: z.ZodType
  params?: z.ZodType
  query?: z.ZodType
}

/**
 * Wrap a handler so it can be `async`, throw the errors in `errors.ts`, and
 * return its response body instead of calling `res.json` itself.
 *
 * Returning `undefined` means "I already wrote the response" — which is what
 * the tracking endpoints (a redirect, a GIF) and the OAuth routes do.
 */
export function route<
  TBody = unknown,
  TParams = unknown,
  TQuery = unknown,
>(
  schemas: Schemas,
  handler: (input: Validated<TBody, TParams, TQuery>) => Promise<unknown> | unknown
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        const input: Validated<TBody, TParams, TQuery> = {
          body: parseWith(schemas.body, req.body, "body") as TBody,
          params: parseWith(schemas.params, req.params, "params") as TParams,
          query: parseWith(schemas.query, req.query, "query") as TQuery,
          req,
          res,
        }

        const result = await handler(input)

        // A handler that wrote the response itself (redirect, image, stream)
        // must not have a JSON body appended after it.
        if (res.headersSent) return
        if (result === undefined) {
          res.status(204).end()
          return
        }
        res.json(result)
      } catch (error) {
        next(error)
      }
    })()
  }
}

function parseWith(schema: z.ZodType | undefined, value: unknown, where: string): unknown {
  if (!schema) return value

  const result = schema.safeParse(value)
  if (result.success) return result.data

  throw new BadRequestError(
    `Invalid request ${where}: ${describeIssues(result.error)}`,
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }))
  )
}

function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
    .join("; ")
}

/**
 * Terminal error middleware. The single place that decides a status code.
 *
 * Unknown errors are logged in full and answered with a bare 500: the message
 * of an unexpected exception may contain a token, a query, or an internal path,
 * and none of that belongs in a browser response.
 */
export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(error)
    return
  }

  if (error instanceof HttpError) {
    // 4xx is the client's problem and expected traffic; only 5xx is ours.
    logger[error.status >= 500 ? "error" : "warn"](
      { code: error.code, status: error.status, details: error.details },
      error.message
    )
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    })
    return
  }

  if (error instanceof ZodError) {
    // A zod failure that escaped `route` — an internal contract, not user input.
    logger.error({ issues: error.issues }, "Unhandled validation failure")
    res.status(500).json({ error: "Internal server error.", code: "internal" })
    return
  }

  if (error instanceof NotFoundError) {
    logger.warn(error.message)
    res.status(404).json({ error: error.message, code: "not_found" })
    return
  }

  /*
   * Both mean "reconnect your Gmail", and both can surface from any route that
   * builds a mailer. Mapped here rather than in each route so no handler has to
   * wrap its own send in a try/catch to get the right status — the frontend
   * branches on `code: "needs_reauth"` to show the Reconnect badge.
   */
  if (error instanceof AccountNeedsReauthError || error instanceof GmailAuthError) {
    logger.warn({ err: error }, "Gmail account needs re-authorization")
    res.status(409).json({ error: error.message, code: "needs_reauth" })
    return
  }

  // Gmail is throttling. 503 + Retry-After rather than 500: it is transient, and
  // the header tells any client (including a browser fetch retry) to wait.
  if (error instanceof GmailRateLimitError) {
    logger.warn({ err: error }, "Gmail rate limited a request")
    res.status(503).set("Retry-After", "60").json({ error: error.message, code: "rate_limited" })
    return
  }

  if (error instanceof GmailMessageError) {
    logger.warn({ err: error }, "Gmail rejected a message")
    res.status(422).json({ error: error.message, code: "message_rejected" })
    return
  }

  /*
   * An empty subject or body. 409, not 400: the request was perfectly valid, the
   * step just isn't finished — and the message is written to be shown verbatim in
   * the UI ("This email has no subject.").
   */
  if (error instanceof EmptyStepError) {
    logger.warn(error.message)
    res.status(409).json({ error: error.message, code: "empty_step" })
    return
  }

  // A tampered or expired click link. Deliberately terse — whoever is probing the
  // redirect learns nothing about why it was refused.
  if (error instanceof InvalidTrackingUrlError) {
    logger.warn({ err: error }, "Rejected a tracking link")
    res.status(400).json({ error: "Invalid tracking link.", code: "invalid_tracking_link" })
    return
  }

  if (error instanceof DatabaseError) {
    logger.error({ operation: error.operation, pg: error.cause }, error.message)
    res.status(500).json({ error: "Database error.", code: "database" })
    return
  }

  logger.error({ err: error }, "Unhandled error")
  res.status(500).json({ error: "Internal server error.", code: "internal" })
}
