import type { NextFunction, Request, RequestHandler, Response } from "express"
import { secretsMatch } from "../crypto.ts"
import { db } from "../db.ts"
import { env } from "../env.ts"
import { ForbiddenError, UnauthorizedError } from "../http/errors.ts"

/**
 * The signed-in owner, attached to the request by `requireUser`.
 *
 * Declaration-merged onto Express's own `Request` so handlers read `req.user`
 * with no cast. It is typed as **optional** on purpose: only routes behind
 * `requireUser` have it, and `req.user!` in a public handler should not compile.
 */
export interface AuthedUser {
  id: string
  email: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser
    }
  }
}

/**
 * Verify the Supabase access token from `Authorization: Bearer …`.
 *
 * The token is verified by asking Supabase (`auth.getUser`) rather than by
 * checking a JWT signature locally: it costs one HTTP call per request, and in a
 * single-user tool that is free, while local verification would need the JWT
 * secret in yet another env var and would keep honouring tokens after a signout.
 */
export const requireUser: RequestHandler = (req, res, next) => {
  void authenticate(req, res, next)
}

async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.header("authorization")

    if (!header?.toLowerCase().startsWith("bearer ")) {
      throw new UnauthorizedError("Missing Authorization: Bearer <token> header.")
    }

    const token = header.slice("bearer ".length).trim()
    if (!token) throw new UnauthorizedError("Empty bearer token.")

    const { data, error } = await db.auth.getUser(token)

    if (error || !data.user) {
      throw new UnauthorizedError("Session expired or invalid — sign in again.")
    }
    if (!data.user.email) {
      // Every sign-in path here is email-based, so this would mean something is
      // badly wrong rather than merely unauthorised.
      throw new UnauthorizedError("Signed-in user has no email address.")
    }

    req.user = { id: data.user.id, email: data.user.email }
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Read `req.user` where the route is already behind `requireUser`.
 *
 * The throw is unreachable in correct wiring; it exists so that forgetting the
 * middleware surfaces as a clear 401 instead of a `TypeError` deep in a query.
 */
export function currentUser(req: Request): AuthedUser {
  if (!req.user) throw new UnauthorizedError("Route is missing the requireUser middleware.")
  return req.user
}

/**
 * Guard for `POST /api/cron/tick`, which is called by an external pinger and so
 * has no user session.
 *
 * With `CRON_SECRET` unset the route is refused outright rather than left open —
 * forgetting to configure it must fail closed.
 */
export const requireCronSecret: RequestHandler = (req, _res, next) => {
  const expected = env.CRON_SECRET

  if (!expected) {
    next(new ForbiddenError("CRON_SECRET is not configured, so this endpoint is disabled."))
    return
  }

  const provided = req.header("x-cron-secret")

  if (!provided || !secretsMatch(expected, provided)) {
    next(new ForbiddenError("Invalid X-Cron-Secret header."))
    return
  }

  next()
}
