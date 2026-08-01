/**
 * The error vocabulary every route throws in. One class per HTTP outcome, so a
 * handler expresses "this lead has no email step" and the error middleware —
 * not the handler — decides the status code and the response shape.
 */

/** Base class for anything that should reach the client as a JSON error. */
export class HttpError extends Error {
  override readonly name = "HttpError"

  constructor(
    readonly status: number,
    message: string,
    /**
     * A stable machine-readable code the frontend can branch on, e.g.
     * `no_account`. The message is for humans and may be reworded freely.
     */
    readonly code: string,
    /** Extra context serialised into the response, e.g. the failing field path. */
    readonly details?: unknown
  ) {
    super(message)
  }
}

/** The request itself is malformed — a failed zod parse, a bad UUID. */
export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, "bad_request", details)
  }
}

/** No valid Supabase session on a route that needs one. */
export class UnauthorizedError extends HttpError {
  constructor(message = "Sign in to continue.") {
    super(401, message, "unauthorized")
  }
}

/** Authenticated, but not allowed — a wrong `CRON_SECRET`, someone else's row. */
export class ForbiddenError extends HttpError {
  constructor(message = "Not allowed.") {
    super(403, message, "forbidden")
  }
}

export class NotFoundHttpError extends HttpError {
  constructor(message = "Not found.") {
    super(404, message, "not_found")
  }
}

/**
 * The request is well-formed but the current state rejects it — launching a
 * lead with an empty opening email, sending with no connected account.
 *
 * This is the interesting one: most of what can go wrong in this app is a state
 * problem, not a validation problem, and 409 lets the UI show the reason
 * verbatim rather than a generic failure toast.
 */
export class ConflictError extends HttpError {
  constructor(message: string, code = "conflict", details?: unknown) {
    super(409, message, code, details)
  }
}

/** The connected Gmail account needs re-authorising before anything can send. */
export class AccountReauthRequiredError extends HttpError {
  constructor(message = "Reconnect your Gmail account to keep sending.") {
    super(409, message, "needs_reauth")
  }
}
